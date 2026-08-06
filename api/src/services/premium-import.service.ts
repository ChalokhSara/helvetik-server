import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { stat, unlink } from 'fs/promises';
import ExcelJS from 'exceljs';
import {
  AgeClass,
  Premium,
  PremiumInsurer,
  PremiumRegion,
  PremiumSource,
  PremiumYear,
  SourceKind,
  TariffType
} from '../models/premium.model';

/**
 * Import des fichiers officiels de l'OFSP.
 *
 * Les classeurs sont lus en flux : `gesamtbericht_ch.xlsx` pèse 15 Mo
 * compressés pour 131 Mo de XML et 217 000 lignes, qu'il serait absurde de
 * charger entièrement en mémoire.
 */

/** Insertions groupées : compromis entre mémoire et allers-retours Mongo. */
const BATCH_SIZE = 5000;

/** Valeur par défaut si l'administrateur n'en fournit pas (année 2026). */
export const DEFAULT_REDISTRIBUTION_YEARLY = 61.8;

export interface ImportOptions {
  filename: string;
  origin: 'UPLOAD' | 'DOWNLOAD';
  importedBy?: string;
  /** Redistribution annuelle par assuré, si connue pour cette année. */
  redistributionYearly?: number;
  /** Autorise la réécriture d'une année déjà active. */
  replaceActive?: boolean;
}

export interface ImportResult {
  kind: SourceKind;
  year: number;
  rows: number;
  status: string;
  message: string;
}

/** « PR-REG CH2 » → 2 ; les cantons à région unique portent « CH0 ». */
function parseRegion(raw: unknown): number | null {
  const match = String(raw ?? '').match(/CH(\d)/);
  return match ? Number(match[1]) : null;
}

/** « FRA-2500 » → 2500. */
function parseFranchise(raw: unknown): number | null {
  const match = String(raw ?? '').match(/FRA-(\d+)/);
  return match ? Number(match[1]) : null;
}

/** « AKL-KIN » → « KIN ». */
function parseAgeClass(raw: unknown): AgeClass | null {
  const match = String(raw ?? '').match(/AKL-(KIN|JUG|ERW)/);
  return match ? (match[1] as AgeClass) : null;
}

/** « TAR-HAM » → « HAM ». */
function parseTariffType(raw: unknown): TariffType | null {
  const match = String(raw ?? '').match(/TAR-(BASE|HAM|HMO|DIV)/);
  return match ? (match[1] as TariffType) : null;
}

/** Les cellules Excel peuvent être des nombres, des chaînes ou du texte enrichi. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object' && value !== null && 'richText' in value) {
    return (value as { richText: { text: string }[] }).richText.map((r) => r.text).join('');
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function cellNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number(String(value ?? '').replace(/[’'\s]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

async function fileDigest(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  const info = await stat(path);
  return { sha256: hash.digest('hex'), size: info.size };
}

/**
 * ExcelJS expose bien le nom de la feuille en flux, mais ne le déclare pas
 * dans ses types : le cast est ici, une seule fois, plutôt qu'à chaque usage.
 */
function sheetName(sheet: unknown): string {
  return String((sheet as { name?: string }).name ?? '');
}

function openWorkbook(path: string) {
  return new ExcelJS.stream.xlsx.WorkbookReader(path, {
    sharedStrings: 'cache',
    worksheets: 'emit',
    entries: 'emit',
    styles: 'ignore'
  });
}

/**
 * Reconnaît le fichier à sa structure plutôt qu'à son nom : l'administrateur
 * peut très bien l'avoir renommé.
 */
export async function detectWorkbookKind(path: string): Promise<SourceKind | null> {
  const workbook = openWorkbook(path);

  for await (const sheet of workbook) {
    const name = sheetName(sheet).trim().toLowerCase();
    if (name === 'export') {
      return 'PREMIUMS';
    }
    if (name === 'indice' || name.startsWith('indice')) {
      return 'INSURERS';
    }
    // Le fichier des régions n'a que des feuilles « SheetN » ; on l'identifie
    // à l'en-tête A_COM/B_NPA de sa cinquième feuille.
    for await (const row of sheet) {
      const first = cellText(row.values ? (row.values as unknown[])[1] : '');
      if (/^(A_COM|B_NPA)/.test(first)) {
        return 'REGIONS';
      }
      break;
    }
  }

  return null;
}

/** Insère les documents par paquets pour ne pas saturer la mémoire. */
async function flush(model: { insertMany: Function }, buffer: unknown[]): Promise<void> {
  if (!buffer.length) {
    return;
  }
  await model.insertMany(buffer, { ordered: false });
  buffer.length = 0;
}

/**
 * Importe le répertoire complet des primes. L'année est lue dans la colonne
 * `Geschäftsjahr` du fichier : c'est la source de vérité, pas le nom du fichier.
 */
async function importPremiums(path: string, options: ImportOptions): Promise<ImportResult> {
  const workbook = openWorkbook(path);

  // Dictionnaire des tarifs (feuille « Wertebereiche »), pour nommer les modèles.
  const tariffNames = new Map<string, string>();
  const rows: Record<string, unknown>[] = [];
  let year: number | null = null;
  let imported = 0;
  let skipped = 0;
  let cleared = false;

  for await (const sheet of workbook) {
    const current = sheetName(sheet).trim().toLowerCase();

    if (current === 'wertebereiche') {
      let first = true;
      for await (const row of sheet) {
        if (first) { first = false; continue; }
        const values = row.values as unknown[];
        const code = cellText(values[3]);
        const label = cellText(values[5]) || cellText(values[4]);
        if (code && label) {
          tariffNames.set(code, label);
        }
      }
      continue;
    }

    if (current !== 'export') {
      continue;
    }

    let first = true;
    for await (const row of sheet) {
      if (first) { first = false; continue; }
      const v = row.values as unknown[];

      const rowYear = cellNumber(v[4]);
      const insurerId = cellNumber(v[1]);
      const canton = cellText(v[2]);
      const region = parseRegion(v[6]);
      const ageClass = parseAgeClass(v[7]);
      const tariffType = parseTariffType(v[10]);
      const franchise = parseFranchise(v[13]);
      const premium = cellNumber(v[14]);
      const accident = cellText(v[8]);

      if (rowYear === null || insurerId === null || !canton || region === null ||
          !ageClass || !tariffType || franchise === null || premium === null) {
        skipped++;
        continue;
      }

      if (year === null) {
        year = rowYear;
        // L'année n'est connue qu'ici : c'est le moment de vider un éventuel
        // import précédent, avant d'écrire quoi que ce soit.
        const existing = await PremiumYear.findOne({ year });
        if (existing?.status === 'ACTIVE' && !options.replaceActive) {
          throw new Error(
            `L'année ${year} est déjà active. Confirmez le remplacement pour la réimporter.`
          );
        }
        await Premium.deleteMany({ year });
        cleared = true;
      } else if (rowYear !== year) {
        // Un fichier ne doit couvrir qu'une année.
        skipped++;
        continue;
      }

      const tariffCode = cellText(v[9]);
      rows.push({
        year,
        insurerId,
        canton,
        region,
        ageClass,
        ageSubgroup: cellText(v[11]) || undefined,
        withAccident: accident.includes('MIT'),
        tariffType,
        tariffCode,
        tariffName: tariffNames.get(tariffCode),
        franchise,
        premium,
        isBase: cellNumber(v[15]) === 1
      });
      imported++;

      if (rows.length >= BATCH_SIZE) {
        await flush(Premium, rows);
      }
    }
  }

  await flush(Premium, rows);

  if (year === null || !cleared) {
    throw new Error('Aucune ligne de prime exploitable dans ce fichier.');
  }

  // Le dictionnaire arrive parfois après les données : compléter les noms.
  if (tariffNames.size) {
    for (const [code, name] of tariffNames) {
      await Premium.updateMany(
        { year, tariffCode: code, tariffName: { $exists: false } },
        { $set: { tariffName: name } }
      );
    }
  }

  await registerSource(year, {
    kind: 'PREMIUMS',
    rows: imported,
    path,
    options
  });

  return {
    kind: 'PREMIUMS',
    year,
    rows: imported,
    status: 'OK',
    message: `${imported.toLocaleString('fr-CH')} prime(s) importée(s) pour ${year}` +
      (skipped ? `, ${skipped} ligne(s) ignorée(s).` : '.')
  };
}

/**
 * Importe la correspondance NPA → région de primes (feuille « B_NPA »).
 * L'année n'est pas dans les données : elle est reprise de l'en-tête.
 */
async function importRegions(path: string, options: ImportOptions): Promise<ImportResult> {
  const workbook = openWorkbook(path);
  const rows: Record<string, unknown>[] = [];
  let year: number | null = null;
  let imported = 0;
  let cleared = false;

  for await (const sheet of workbook) {
    let headerSeen = false;
    let isTarget = false;

    for await (const row of sheet) {
      const v = row.values as unknown[];
      const first = cellText(v[1]);

      // « Régions de primes valables du 01.01.2026 au 31.12.2026 »
      if (year === null) {
        const match = first.match(/(?:01\.01\.|ab\s+01\.01\.)(\d{4})/);
        if (match) {
          year = Number(match[1]);
        }
      }

      if (/^B_NPA/.test(first)) {
        isTarget = true;
        continue;
      }
      if (!isTarget) {
        continue;
      }

      // En-tête de colonnes : « NPA | Localité | Canton | Région | No OFS | Commune »
      if (!headerSeen) {
        if (/NPA|PLZ/i.test(cellText(v[2]))) {
          headerSeen = true;
        }
        continue;
      }

      const plz = cellText(v[2]);
      const locality = cellText(v[3]);
      const canton = cellText(v[4]);
      const region = cellNumber(v[5]);
      const bfsNumber = cellNumber(v[6]);
      const commune = cellText(v[7]);

      if (!/^\d{4}$/.test(plz) || !canton || region === null || bfsNumber === null) {
        continue;
      }

      // La purge doit précéder la toute première écriture, sinon elle
      // emporterait les paquets déjà insérés.
      if (!cleared) {
        await PremiumRegion.deleteMany({ year });
        cleared = true;
      }

      rows.push({ year, plz, locality, canton, region, bfsNumber, commune });
      imported++;

      if (rows.length >= BATCH_SIZE) {
        await flush(PremiumRegion, rows);
      }
    }
  }

  if (year === null) {
    throw new Error('Année introuvable dans le fichier des régions de primes.');
  }
  if (!imported) {
    throw new Error('Aucune correspondance NPA → région trouvée dans ce fichier.');
  }

  await flush(PremiumRegion, rows);

  await registerSource(year, { kind: 'REGIONS', rows: imported, path, options });

  return {
    kind: 'REGIONS',
    year,
    rows: imported,
    status: 'OK',
    message: `${imported.toLocaleString('fr-CH')} correspondance(s) NPA → région pour ${year}.`
  };
}

/** Importe la liste des assureurs admis (feuille « Indice »). */
async function importInsurers(path: string, options: ImportOptions): Promise<ImportResult> {
  const workbook = openWorkbook(path);
  const rows: Record<string, unknown>[] = [];
  let year: number | null = null;
  let imported = 0;

  for await (const sheet of workbook) {
    for await (const row of sheet) {
      const v = row.values as unknown[];

      if (year === null) {
        // « Janvier 2026 », ou le millésime du titre.
        const match = cellText(v[2]).match(/(20\d{2})/) || cellText(v[1]).match(/(20\d{2})/);
        if (match) {
          year = Number(match[1]);
        }
      }

      const insurerId = cellNumber(v[2]);
      const name = cellText(v[4]);
      const locality = cellText(v[5]);

      if (insurerId === null || !name || !/^\d+$/.test(String(v[2] ?? '').trim())) {
        continue;
      }
      rows.push({ year, insurerId, name, locality: locality || undefined });
      imported++;
    }
  }

  if (year === null) {
    throw new Error('Année introuvable dans le fichier des assureurs admis.');
  }
  if (!imported) {
    throw new Error('Aucun assureur trouvé dans ce fichier.');
  }

  await PremiumInsurer.deleteMany({ year });
  // Le même identifiant apparaît sur plusieurs feuilles : on ne garde que le premier.
  const unique = new Map<number, unknown>();
  for (const row of rows) {
    const id = (row as { insurerId: number }).insurerId;
    if (!unique.has(id)) {
      unique.set(id, row);
    }
  }
  await PremiumInsurer.insertMany([...unique.values()], { ordered: false });

  await registerSource(year, { kind: 'INSURERS', rows: unique.size, path, options });

  return {
    kind: 'INSURERS',
    year,
    rows: unique.size,
    status: 'OK',
    message: `${unique.size} assureur(s) importé(s) pour ${year}.`
  };
}

/** Enregistre la provenance du fichier et met à jour les compteurs de l'année. */
async function registerSource(
  year: number,
  input: { kind: SourceKind; rows: number; path: string; options: ImportOptions }
): Promise<void> {
  const { sha256, size } = await fileDigest(input.path);

  const source: PremiumSource = {
    kind: input.kind,
    filename: input.options.filename,
    sha256,
    size,
    rows: input.rows,
    origin: input.options.origin,
    importedAt: new Date(),
    importedBy: input.options.importedBy
  };

  const existing = await PremiumYear.findOne({ year });
  const counters = {
    PREMIUMS: 'premiumRows',
    REGIONS: 'regionRows',
    INSURERS: 'insurerRows'
  } as const;

  if (!existing) {
    await PremiumYear.create({
      year,
      status: 'DRAFT',
      redistributionYearly: input.options.redistributionYearly ?? DEFAULT_REDISTRIBUTION_YEARLY,
      [counters[input.kind]]: input.rows,
      sources: [source]
    });
    return;
  }

  // Une source remplace la précédente du même type.
  existing.sources = existing.sources.filter((s) => s.kind !== input.kind);
  existing.sources.push(source);
  (existing as unknown as Record<string, number>)[counters[input.kind]] = input.rows;
  if (input.options.redistributionYearly !== undefined) {
    existing.redistributionYearly = input.options.redistributionYearly;
  }
  await existing.save();
}

/**
 * Point d'entrée : reconnaît le fichier et l'importe.
 * Le fichier temporaire est supprimé dans tous les cas.
 */
export async function importWorkbook(path: string, options: ImportOptions): Promise<ImportResult> {
  try {
    let kind: SourceKind | null;
    try {
      kind = await detectWorkbookKind(path);
    } catch (err) {
      // ExcelJS remonte des erreurs de bas niveau (« invalid signature… ») qui
      // ne disent rien à un administrateur.
      throw new Error(
        'Fichier illisible : ce n\'est pas un classeur Excel valide. ' +
        `Détail technique : ${(err as Error).message}`
      );
    }

    if (!kind) {
      throw new Error(
        'Fichier non reconnu. Attendu : le répertoire des primes (feuille « Export »), ' +
        'les régions de primes (feuille « B_NPA ») ou les assureurs admis (feuille « Indice »).'
      );
    }

    if (kind === 'PREMIUMS') return await importPremiums(path, options);
    if (kind === 'REGIONS') return await importRegions(path, options);
    return await importInsurers(path, options);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

/** Rend une année utilisable par l'API et archive celle qui l'était. */
export async function activateYear(year: number): Promise<void> {
  const target = await PremiumYear.findOne({ year });
  if (!target) {
    throw new Error(`Aucun import pour l'année ${year}.`);
  }
  if (!target.premiumRows) {
    throw new Error(`L'année ${year} ne contient aucune prime : importez d'abord le répertoire.`);
  }
  if (!target.regionRows) {
    throw new Error(`L'année ${year} n'a pas de régions de primes : importez praemienregionen.xlsx.`);
  }

  await PremiumYear.updateMany({ status: 'ACTIVE', year: { $ne: year } }, { $set: { status: 'ARCHIVED' } });
  target.status = 'ACTIVE';
  target.activatedAt = new Date();
  await target.save();
}

/** Supprime une année et toutes ses données. Une année active est protégée. */
export async function deleteYear(year: number): Promise<void> {
  const target = await PremiumYear.findOne({ year });
  if (!target) {
    throw new Error(`Aucun import pour l'année ${year}.`);
  }
  if (target.status === 'ACTIVE') {
    throw new Error('Impossible de supprimer l\'année active. Activez d\'abord une autre année.');
  }

  await Promise.all([
    Premium.deleteMany({ year }),
    PremiumRegion.deleteMany({ year }),
    PremiumInsurer.deleteMany({ year })
  ]);
  await PremiumYear.deleteOne({ year });
}

/** L'année servie par l'API, ou `null` tant qu'aucun import n'est activé. */
export async function activeYear() {
  return PremiumYear.findOne({ status: 'ACTIVE' });
}
