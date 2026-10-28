import { createWriteStream } from 'fs';
import { mkdir, unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import { PremiumYear } from '../models/premium.model';
import { importWorkbook, ImportResult } from './premium-import.service';
import { updateRedistribution } from './redistribution.service';

/**
 * Téléchargement des fichiers officiels de l'OFSP.
 *
 * Depuis la publication des primes 2027 (automne 2026), les fichiers ne sont
 * plus à des adresses fixes :
 *   - le répertoire complet des primes a quitté priminfo pour opendata.swiss,
 *     sous le nom `Prämien_CH.xlsx` et dans un nouveau format (cf. l'import) ;
 *   - les régions et la liste des assureurs restent sur priminfo, mais leur
 *     nom porte désormais l'année (`praemienregionen-2027.xlsx`) ou le mois
 *     de publication (`assureurs-maladie-admis-2026-10.xlsx`).
 *
 * Les deux derniers sont donc relevés sur la page « Année de prime actuelle »
 * de priminfo, qui pointe toujours vers les fichiers en vigueur. Les adresses
 * reconstituées ne servent qu'en repli, si la page est injoignable.
 *
 * La synchronisation compare l'empreinte du fichier téléchargé à celle du
 * dernier import : rien n'est réimporté tant que l'OFSP n'a rien publié de neuf.
 */

const BASE_URL = process.env.PRIMINFO_BASE_URL || 'https://www.priminfo.admin.ch';
const DOWNLOADS_PAGE = `${BASE_URL}/fr/downloads/aktuell`;

/**
 * Répertoire des primes sur opendata.swiss (OFSP). Le chemin, encodé en base64
 * dans l'adresse, est « /Praemien/Prämien_CH.xlsx » : l'OFSP y remplace le
 * fichier chaque année sans en changer le nom.
 */
const PREMIUMS_URL = process.env.OFSP_PREMIUMS_URL ||
  'https://opendata.bagnet.ch/?r=/download&path=L1ByYWVtaWVuL1Byw6RtaWVuX0NILnhsc3g%3D';

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const PAGE_TIMEOUT_MS = 30 * 1000;

export interface SyncOutcome {
  results: ImportResult[];
  skipped: string[];
  errors: string[];
}

interface Source {
  kind: string;
  url: string;
  filename: string;
}

/** Liens de la page priminfo : le premier qui correspond au motif. */
export function findDownloadLink(html: string, pattern: RegExp): string | undefined {
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    if (pattern.test(match[1])) {
      return new URL(match[1], BASE_URL).toString();
    }
  }
  return undefined;
}

async function fetchDownloadsPage(): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const response = await fetch(DOWNLOADS_PAGE, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Helvetik/1.0' }
    });
    return response.ok ? await response.text() : undefined;
  } catch (err) {
    console.error('[primes] page des téléchargements injoignable :', (err as Error).message);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function sourceUrls(year: number): Promise<Source[]> {
  const page = await fetchDownloadsPage();

  const regions = (page && findDownloadLink(page, /\/downloads\/praemienregionen-\d{4}\.xlsx$/)) ||
    `${BASE_URL}/downloads/praemienregionen-${year}.xlsx`;
  // Publiée chaque mois : la plus récente figure seule sur la page.
  const insurers = (page && findDownloadLink(page, /\/downloads\/assureurs-maladie-admis-[\d-]+\.xlsx$/)) ||
    `${BASE_URL}/downloads/assureurs-maladie-admis-${year}-01-01.xlsx`;

  return [
    { kind: 'PREMIUMS', url: PREMIUMS_URL, filename: 'Praemien_CH.xlsx' },
    { kind: 'REGIONS', url: regions, filename: regions.split('/').pop() as string },
    { kind: 'INSURERS', url: insurers, filename: insurers.split('/').pop() as string }
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
 * L'année visée ne sert qu'aux adresses de repli, quand la page de priminfo
 * est injoignable : l'année réelle des données est toujours lue dans les
 * fichiers eux-mêmes.
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

  for (const source of await sourceUrls(year)) {
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

  // Nouvelles primes : la redistribution de l'année est lue sur priminfo, au
  // lieu d'hériter d'une valeur figée qui fausserait chaque prime affichée.
  // Seulement à l'import des primes, pour ne pas écraser une correction faite
  // depuis la console lors d'une synchronisation sans nouveauté.
  for (const result of outcome.results.filter((r) => r.kind === 'PREMIUMS')) {
    const message = await updateRedistribution(result.year);
    if (message) {
      outcome.skipped.push(message);
    }
  }

  return outcome;
}
