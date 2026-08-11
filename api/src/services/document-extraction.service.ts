import { readFile } from 'fs/promises';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PremiumInsurer } from '../models/premium.model';
import { activeYear } from './premium-import.service';

/**
 * Pré-remplissage à partir d'un document : carte d'assuré photographiée, ou
 * police d'assurance en PDF.
 *
 * Rien n'est enregistré automatiquement. L'extraction alimente un formulaire
 * que l'assuré relit et corrige : une reconnaissance de caractères se trompe,
 * et se tromper sur un numéro AVS ou une prime a des conséquences.
 *
 * Deux chemins selon le fichier :
 *   - PDF  : extraction du texte, exacte et instantanée
 *   - image : reconnaissance optique (tesseract), approximative
 */

const OCR_LANGUAGES = process.env.OCR_LANGUAGES || 'fra+deu';
const OCR_TIMEOUT_MS = 60_000;

/**
 * Les données de langue sont téléchargées au premier usage puis mises en
 * cache. En conteneur, ce dossier doit être accessible en écriture et l'hôte
 * doit pouvoir joindre le CDN au moins une fois.
 */
const CACHE_PATH = process.env.TESSERACT_CACHE_PATH || join(tmpdir(), 'helvetik-tessdata');

export interface ExtractedField<T = string> {
  value: T;
  /** Ce qui a permis de le reconnaître, affiché à l'assuré. */
  evidence: string;
}

export interface ExtractionResult {
  source: 'PDF' | 'IMAGE';
  /** Longueur du texte lu, utile pour distinguer un scan illisible d'un échec. */
  characters: number;
  fields: {
    avsNum?: ExtractedField;
    birthdate?: ExtractedField;
    firstname?: ExtractedField;
    name?: ExtractedField;
    provider?: ExtractedField;
    policyNumber?: ExtractedField;
    premiumAmount?: ExtractedField;
    franchise?: ExtractedField;
    plz?: ExtractedField;
    location?: ExtractedField;
  };
  warnings: string[];
}

/** Texte d'un PDF : exact, sans reconnaissance de caractères. */
async function readPdf(path: string): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: await readFile(path) });
  try {
    const result = await parser.getText();
    return String(result.text || '');
  } finally {
    await parser.destroy();
  }
}

/** Texte d'une image, par reconnaissance optique. */
async function readImage(path: string): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  await mkdir(CACHE_PATH, { recursive: true });

  const worker = await createWorker(OCR_LANGUAGES.split('+'), 1, { cachePath: CACHE_PATH });
  try {
    const recognition = await Promise.race([
      worker.recognize(path),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('délai dépassé')), OCR_TIMEOUT_MS))
    ]);
    return String(recognition.data.text || '');
  } finally {
    await worker.terminate();
  }
}

/** Normalise pour la recherche : minuscules, sans accents ni ponctuation superflue. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Numéro AVS suisse : 756 suivi de 10 chiffres. La reconnaissance optique
 * confond volontiers séparateurs et espaces, d'où la souplesse du motif.
 */
function findAvs(text: string): ExtractedField | undefined {
  const match = text.match(/\b756[.\s-]?(\d{4})[.\s-]?(\d{4})[.\s-]?(\d{2})\b/);
  if (!match) {
    return undefined;
  }
  return {
    value: `756.${match[1]}.${match[2]}.${match[3]}`,
    evidence: match[0].trim()
  };
}

/** Date au format suisse, la plus ancienne étant le plus souvent la naissance. */
function findBirthdate(text: string): ExtractedField | undefined {
  const matches = [...text.matchAll(/\b(\d{2})[.\/-](\d{2})[.\/-](\d{4})\b/g)];
  const dates = matches
    .map((m) => ({ raw: m[0], date: new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))) }))
    .filter((d) => !Number.isNaN(d.date.getTime()) &&
      d.date.getUTCFullYear() >= 1900 &&
      d.date.getTime() < Date.now());

  if (!dates.length) {
    return undefined;
  }
  const oldest = dates.sort((a, b) => a.date.getTime() - b.date.getTime())[0];
  return { value: oldest.date.toISOString().slice(0, 10), evidence: oldest.raw };
}

/** NPA et localité, tels qu'ils apparaissent sur une adresse suisse. */
function findLocality(text: string): { plz?: ExtractedField; location?: ExtractedField } {
  const match = text.match(/\b([1-9]\d{3})\s+([A-ZÄÖÜÉÈÀ][\wäöüéèàç'’-]{2,30}(?:\s[A-ZÄÖÜÉÈÀ][\wäöüéèàç'’-]{2,30})?)/);
  if (!match) {
    return {};
  }
  return {
    plz: { value: match[1], evidence: match[0].trim() },
    location: { value: match[2].trim(), evidence: match[0].trim() }
  };
}

/**
 * Caisse maladie : confrontée à la liste officielle des assureurs importée,
 * ce qui donne une reconnaissance fiable là où une heuristique textuelle
 * serait hasardeuse.
 */
async function findProvider(text: string): Promise<ExtractedField | undefined> {
  const year = await activeYear();
  if (!year) {
    return undefined;
  }

  const insurers = await PremiumInsurer.find({ year: year.year }).select('name');
  const haystack = normalize(text);

  const matches = insurers
    .map((insurer) => {
      // Le premier mot du nom officiel suffit : « CSS Assurance-maladie SA »
      // est imprimé « CSS » sur la carte.
      const key = normalize(insurer.name).split(/[\s-]+/)[0];
      return { name: insurer.name, key };
    })
    .filter((candidate) => candidate.key.length >= 3 && haystack.includes(candidate.key));

  if (!matches.length) {
    return undefined;
  }

  // Le nom le plus long l'emporte : il est le plus discriminant.
  const best = matches.sort((a, b) => b.key.length - a.key.length)[0];
  return { value: best.name, evidence: best.key };
}

/** Montants en francs, pour retrouver prime et franchise sur une police. */
function findAmounts(text: string): { premiumAmount?: ExtractedField; franchise?: ExtractedField } {
  const result: { premiumAmount?: ExtractedField; franchise?: ExtractedField } = {};

  const premium = text.match(/(?:prime|prämie|premio)[^\d]{0,40}(\d{1,4}[.,]\d{2})/i);
  if (premium) {
    result.premiumAmount = {
      value: premium[1].replace(',', '.'),
      evidence: premium[0].replace(/\s+/g, ' ').trim().slice(0, 60)
    };
  }

  // Franchise : seules les valeurs légales sont retenues, ce qui écarte les
  // nombres qui traînent dans le document.
  const legal = new Set(['0', '100', '200', '300', '400', '500', '600', '1000', '1500', '2000', '2500']);
  const franchise = [...text.matchAll(/(?:franchise|jahresfranchise|franchigia)[^\d]{0,40}(\d{1,4})/gi)]
    .map((m) => m[1].replace(/['’\s]/g, ''))
    .find((value) => legal.has(value));
  if (franchise) {
    result.franchise = { value: franchise, evidence: `franchise ${franchise}` };
  }

  return result;
}

/** Numéro de police, repéré par son étiquette : sans elle, trop ambigu. */
function findPolicyNumber(text: string): ExtractedField | undefined {
  const match = text.match(/(?:n[o°]?\s*(?:de\s*)?police|policenummer|police\s*n[o°]?|versichertennummer|n[o°]\s*d.assur[ée])[^\dA-Z]{0,10}([A-Z0-9][A-Z0-9.\-\/]{4,24})/i);
  return match
    ? { value: match[1].trim(), evidence: match[0].replace(/\s+/g, ' ').trim().slice(0, 60) }
    : undefined;
}

/**
 * Nom et prénom : cherchés derrière une étiquette explicite. Sans étiquette,
 * on renonce plutôt que de proposer un mot pris au hasard dans le document.
 */
function findNames(text: string): { firstname?: ExtractedField; name?: ExtractedField } {
  const result: { firstname?: ExtractedField; name?: ExtractedField } = {};

  const firstname = text.match(/(?:pr[ée]nom|vorname|nome)\s*:?\s*([A-ZÄÖÜÉÈÀ][\p{L}'’-]{1,30})/iu);
  if (firstname) {
    result.firstname = { value: firstname[1].trim(), evidence: firstname[0].trim() };
  }

  const name = text.match(/(?:^|\n)\s*(?:nom|name|cognome)\s*:?\s*([A-ZÄÖÜÉÈÀ][\p{L}'’-]{1,30})/iu);
  if (name) {
    result.name = { value: name[1].trim(), evidence: name[0].trim() };
  }

  return result;
}

/** Formats acceptés au dépôt. */
export function isSupportedDocument(mimetype: string, filename: string): boolean {
  return /^image\/(jpeg|png|webp|heic|heif)$/i.test(mimetype) ||
    mimetype === 'application/pdf' ||
    /\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(filename);
}

export async function extractFromDocument(
  path: string,
  mimetype: string,
  filename: string
): Promise<ExtractionResult> {
  const isPdf = mimetype === 'application/pdf' || /\.pdf$/i.test(filename);
  const warnings: string[] = [];

  let text: string;
  try {
    text = isPdf ? await readPdf(path) : await readImage(path);
  } catch (err) {
    throw new Error(
      isPdf
        ? `Ce PDF n'a pas pu être lu (${(err as Error).message}).`
        : `L'image n'a pas pu être analysée (${(err as Error).message}). ` +
          'Réessayez avec une photo bien éclairée et cadrée sur le document.'
    );
  }

  const compact = text.replace(/[ \t]+/g, ' ');
  if (compact.trim().length < 20) {
    warnings.push(
      isPdf
        ? 'Ce PDF ne contient pas de texte : il s\'agit probablement d\'un scan. Photographiez plutôt le document.'
        : 'Très peu de texte a été reconnu sur l\'image.'
    );
  }

  const locality = findLocality(compact);
  const amounts = findAmounts(compact);
  const names = findNames(compact);

  const fields: ExtractionResult['fields'] = {
    avsNum: findAvs(compact),
    birthdate: findBirthdate(compact),
    provider: await findProvider(compact),
    policyNumber: findPolicyNumber(compact),
    ...locality,
    ...amounts,
    ...names
  };

  if (!Object.values(fields).some(Boolean)) {
    warnings.push('Aucune donnée exploitable n\'a été reconnue : saisissez les informations à la main.');
  }

  return {
    source: isPdf ? 'PDF' : 'IMAGE',
    characters: compact.trim().length,
    fields,
    warnings
  };
}

/** Résumé lisible de ce qui a été reconnu, à afficher au-dessus du formulaire. */
export function describeExtraction(result: ExtractionResult): string {
  const labels: Record<string, string> = {
    avsNum: 'n° AVS',
    birthdate: 'date de naissance',
    firstname: 'prénom',
    name: 'nom',
    provider: 'caisse',
    policyNumber: 'n° de police',
    premiumAmount: 'prime',
    franchise: 'franchise',
    plz: 'NPA',
    location: 'localité'
  };

  const found = Object.entries(result.fields)
    .filter(([, field]) => Boolean(field))
    .map(([key]) => labels[key] || key);

  return found.length
    ? `Reconnu depuis votre ${result.source === 'PDF' ? 'document' : 'photo'} : ${found.join(', ')}. ` +
      'Vérifiez chaque champ avant d\'enregistrer.'
    : 'Rien n\'a pu être reconnu automatiquement.';
}
