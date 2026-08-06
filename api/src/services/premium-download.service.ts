import { createWriteStream } from 'fs';
import { mkdir, unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import { PremiumYear } from '../models/premium.model';
import { importWorkbook, ImportResult } from './premium-import.service';

/**
 * Téléchargement des fichiers officiels depuis priminfo.admin.ch.
 *
 * Les trois URL sont stables d'une année sur l'autre — seul le fichier des
 * assureurs porte une date, reconstituée depuis l'année visée. Le contenu, lui,
 * est remplacé chaque année par l'OFSP.
 *
 * La synchronisation compare l'empreinte du fichier téléchargé à celle du
 * dernier import : rien n'est réimporté tant que l'OFSP n'a rien publié de neuf.
 */

const BASE_URL = process.env.PRIMINFO_BASE_URL || 'https://www.priminfo.admin.ch';
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export interface SyncOutcome {
  results: ImportResult[];
  skipped: string[];
  errors: string[];
}

function sourceUrls(year: number): Array<{ kind: string; url: string; filename: string }> {
  return [
    {
      kind: 'PREMIUMS',
      url: `${BASE_URL}/downloads/gesamtbericht_ch.xlsx`,
      filename: 'gesamtbericht_ch.xlsx'
    },
    {
      kind: 'REGIONS',
      url: `${BASE_URL}/downloads/praemienregionen.xlsx`,
      filename: 'praemienregionen.xlsx'
    },
    {
      // Seule URL datée : l'OFSP la publie au 1er janvier de l'année visée.
      kind: 'INSURERS',
      url: `${BASE_URL}/downloads/assureurs-maladie-admis-${year}-01-01.xlsx`,
      filename: `assureurs-maladie-admis-${year}-01-01.xlsx`
    }
  ];
}

async function download(url: string, destination: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Helvetik/1.0' }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error('réponse vide');
    }
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Récupère les fichiers de l'OFSP et les importe.
 *
 * L'année visée sert uniquement à construire l'URL du fichier des assureurs :
 * l'année réelle des données est toujours lue dans les fichiers eux-mêmes.
 */
export async function syncPremiumsFromOfsp(options: {
  targetYear?: number;
  importedBy?: string;
  /** Réimporte même si l'empreinte du fichier est inchangée. */
  force?: boolean;
  replaceActive?: boolean;
} = {}): Promise<SyncOutcome> {
  const year = options.targetYear ?? new Date().getFullYear();
  const workDir = join(tmpdir(), 'helvetik-premium-sync');
  await mkdir(workDir, { recursive: true });

  const known = await PremiumYear.find().select('sources');
  const knownDigests = new Set(known.flatMap((y) => y.sources.map((s) => s.sha256)));

  const outcome: SyncOutcome = { results: [], skipped: [], errors: [] };

  for (const source of sourceUrls(year)) {
    const destination = join(workDir, `${Date.now()}-${source.filename}`);
    try {
      await download(source.url, destination);

      if (!options.force) {
        // Comparer l'empreinte avant d'importer évite de réécrire 217 000
        // documents pour rien à chaque passage du planificateur.
        const { createHash } = await import('crypto');
        const { createReadStream } = await import('fs');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(destination)) {
          hash.update(chunk as Buffer);
        }
        if (knownDigests.has(hash.digest('hex'))) {
          await unlink(destination).catch(() => undefined);
          outcome.skipped.push(`${source.filename} : déjà importé, inchangé.`);
          continue;
        }
      }

      // importWorkbook supprime le fichier temporaire dans tous les cas.
      outcome.results.push(await importWorkbook(destination, {
        filename: source.filename,
        origin: 'DOWNLOAD',
        importedBy: options.importedBy,
        replaceActive: options.replaceActive
      }));
    } catch (err) {
      await unlink(destination).catch(() => undefined);
      const message = (err as Error).message;
      outcome.errors.push(`${source.filename} : ${message}`);
      console.error(`[primes] échec du téléchargement de ${source.filename} :`, message);
    }
  }

  return outcome;
}
