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
  /**
   * Texte reconnu, conservé pour les analyses qui ont besoin d'un référentiel
   * externe — reconnaître un modèle LAMal suppose de connaître le catalogue
   * officiel de la région, que ce module n'a pas à charger.
   */
  text: string;
  fields: {
    avsNum?: ExtractedField;
    birthdate?: ExtractedField;
    firstname?: ExtractedField;
    name?: ExtractedField;
    sexe?: ExtractedField;
    nationality?: ExtractedField;
    provider?: ExtractedField;
    policyNumber?: ExtractedField;
    premiumAmount?: ExtractedField;
    franchise?: ExtractedField;
    plz?: ExtractedField;
    location?: ExtractedField;
  };
  warnings: string[];
}

/** Pages d'un PDF scanné soumises à la reconnaissance : une pièce ou une police tient en deux. */
const SCANNED_PDF_PAGES = 2;

/** Taille visée pour le plus grand côté d'une image avant reconnaissance. */
const OCR_TARGET_SIDE = 2400;

/** En dessous, la lecture est jugée douteuse et les autres orientations sont essayées. */
const OCR_CONFIDENCE_OK = 60;

const MRZ_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';

/** Ce que la reconnaissance a tiré d'un document. */
interface DocumentText {
  text: string;
  /** Texte d'une passe réservée à la bande MRZ, quand elle a abouti. */
  mrzText?: string;
}

/**
 * Texte d'un document. Un PDF à couche texte est lu tel quel ; un PDF issu
 * d'un scanner, qui ne contient que des images, et une photo passent par la
 * reconnaissance optique.
 */
async function readDocument(path: string, isPdf: boolean): Promise<DocumentText> {
  if (!isPdf) {
    return readImages([await readFile(path)]);
  }

  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: await readFile(path) });
  try {
    const text = String((await parser.getText()).text || '');
    if (text.replace(/\s+/g, '').length >= 20) {
      return { text };
    }
    // Rendu large : une carte scannée sur une page A4 n'en occupe qu'une partie.
    const shots = await parser.getScreenshot({
      first: SCANNED_PDF_PAGES,
      desiredWidth: 3000,
      imageBuffer: true,
      imageDataUrl: false
    });
    return await readImages(shots.pages.map((page) => Buffer.from(page.data)));
  } finally {
    await parser.destroy();
  }
}

type Canvas = import('@napi-rs/canvas').Canvas;

/**
 * Image préparée pour la reconnaissance, en deux versions, ou `null` si elle
 * ne peut pas être décodée ici (HEIC, notamment) : elle part alors brute.
 *
 * - `ink` : les pièces d'identité sont imprimées sur des fonds de sécurité
 *   colorés (guillochis) qui noient le texte. Garder, pour chaque pixel, la
 *   plus claire de ses trois composantes efface ces encres colorées et laisse
 *   intact le texte noir — dont la bande MRZ.
 * - `luma` : niveaux de gris ordinaires, qui conservent le texte imprimé en
 *   couleur (nom de caisse, titres) que la première version effacerait.
 *
 * Un scan pose souvent une petite carte au coin d'une page A4 blanche :
 * l'image est d'abord recadrée sur ce qui n'est pas du papier blanc, faute de
 * quoi la mise à l'échelle réduirait le texte jusqu'à le rendre illisible.
 */
async function prepareImage(source: Buffer): Promise<{ ink: Canvas; luma: Canvas } | null> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  let image;
  try {
    image = await loadImage(source);
  } catch {
    return null;
  }

  // Pleine résolution, plafonnée pour ne pas épuiser la mémoire.
  const cap = Math.min(1, 5000 / Math.max(image.width, image.height));
  const full = createCanvas(Math.round(image.width * cap), Math.round(image.height * cap));
  const fullCtx = full.getContext('2d');
  fullCtx.fillStyle = '#fff';
  fullCtx.fillRect(0, 0, full.width, full.height);
  fullCtx.drawImage(image, 0, 0, full.width, full.height);
  const crop = inkBounds(fullCtx.getImageData(0, 0, full.width, full.height));

  const longest = Math.max(crop.width, crop.height);
  const scale = Math.min(3, Math.max(0.4, OCR_TARGET_SIDE / longest));
  const scaled = () => {
    const canvas = createCanvas(Math.round(crop.width * scale), Math.round(crop.height * scale));
    canvas.getContext('2d')
      .drawImage(full, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  return {
    ink: toGray(scaled(), (r, g, b) => Math.max(r, g, b)),
    luma: toGray(scaled(), (r, g, b) => Math.round(0.299 * r + 0.587 * g + 0.114 * b))
  };
}

/** Niveaux de gris selon `measure`, puis étirement du contraste. */
function toGray(canvas: Canvas, measure: (r: number, g: number, b: number) => number): Canvas {
  const ctx = canvas.getContext('2d');
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const value = measure(data[i], data[i + 1], data[i + 2]);
    data[i] = value;
    histogram[value]++;
  }

  // Étirement entre le 1er et le 99e centile : un reflet ou une ombre ne
  // doivent pas fixer à eux seuls le blanc et le noir de toute l'image.
  const total = data.length / 4;
  let low = 0;
  let high = 255;
  for (let v = 0, seen = 0; v < 256; v++) {
    seen += histogram[v];
    if (seen >= total * 0.01) { low = v; break; }
  }
  for (let v = 255, seen = 0; v >= 0; v--) {
    seen += histogram[v];
    if (seen >= total * 0.01) { high = v; break; }
  }
  const range = Math.max(1, high - low);
  for (let i = 0; i < data.length; i += 4) {
    const value = Math.min(255, Math.max(0, Math.round((data[i] - low) * 255 / range)));
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

/**
 * Rectangle qui englobe tout ce qui n'est pas du papier blanc (texte sombre
 * comme texte ou aplats colorés), avec une marge. Une ligne ou une colonne
 * ne compte que si elle en porte assez : une poussière sur la vitre du
 * scanner ne doit pas étendre le cadre. Sans zone nette, l'image entière est
 * gardée.
 */
function inkBounds(pixels: { data: Uint8ClampedArray; width: number; height: number }) {
  const { data, width, height } = pixels;
  const rows = new Uint32Array(height);
  const cols = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.min(data[i], data[i + 1], data[i + 2]) < 160) {
        rows[y]++;
        cols[x]++;
      }
    }
  }

  const span = (counts: Uint32Array, minimum: number) => {
    let first = -1;
    let last = -1;
    counts.forEach((count, index) => {
      if (count >= minimum) {
        if (first < 0) { first = index; }
        last = index;
      }
    });
    return first < 0 ? null : { first, last };
  };
  const ys = span(rows, Math.max(3, width * 0.004));
  const xs = span(cols, Math.max(3, height * 0.004));
  const whole = { x: 0, y: 0, width, height };
  if (!ys || !xs) {
    return whole;
  }

  const marginX = Math.round(width * 0.03);
  const marginY = Math.round(height * 0.03);
  const x = Math.max(0, xs.first - marginX);
  const y = Math.max(0, ys.first - marginY);
  const box = {
    x,
    y,
    width: Math.min(width, xs.last + marginX) - x,
    height: Math.min(height, ys.last + marginY) - y
  };
  // Un cadre minuscule trahit une tache plutôt qu'un document.
  return box.width * box.height < width * height * 0.02 ? whole : box;
}

/** Copie tournée d'un quart de tour, d'un demi-tour ou de trois quarts. */
async function rotated(canvas: Canvas, degrees: number): Promise<Canvas> {
  if (!degrees) {
    return canvas;
  }
  const { createCanvas } = await import('@napi-rs/canvas');
  const quarter = degrees % 180 !== 0;
  const out = createCanvas(quarter ? canvas.height : canvas.width, quarter ? canvas.width : canvas.height);
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/**
 * Reconnaissance d'une ou plusieurs images.
 *
 * Une photo prise de travers, voire tête en bas, est courante : si la
 * première lecture est peu sûre, les autres orientations sont essayées et la
 * plus confiante l'emporte. La bande MRZ, elle, fait l'objet d'une passe à
 * part, restreinte à son alphabet, qui n'est retenue que si ses chiffres de
 * contrôle concordent.
 */
async function readImages(sources: Buffer[]): Promise<DocumentText> {
  const { createWorker } = await import('tesseract.js');
  await mkdir(CACHE_PATH, { recursive: true });

  const worker = await createWorker(OCR_LANGUAGES.split('+'), 1, { cachePath: CACHE_PATH });
  const recognize = async (image: Buffer | Canvas) => {
    const input = Buffer.isBuffer(image) ? image : image.toBuffer('image/png');
    const recognition = await Promise.race([
      // rotateAuto redresse une photo prise légèrement de biais.
      worker.recognize(input, { rotateAuto: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('délai dépassé')), OCR_TIMEOUT_MS))
    ]);
    return { text: String(recognition.data.text || ''), confidence: recognition.data.confidence };
  };

  try {
    const texts: string[] = [];
    let mrzText: string | undefined;

    for (const source of sources) {
      const prepared = await prepareImage(source);
      if (!prepared) {
        texts.push((await recognize(source)).text);
        continue;
      }

      // L'orientation est déterminée sur la version « encre », la plus nette,
      // puis appliquée à l'autre.
      let best = { ...(await recognize(prepared.ink)), degrees: 0 };
      if (best.confidence < OCR_CONFIDENCE_OK) {
        for (const degrees of [180, 90, 270]) {
          const attempt = await recognize(await rotated(prepared.ink, degrees));
          if (attempt.confidence > best.confidence) {
            best = { ...attempt, degrees };
          }
          if (best.confidence >= OCR_CONFIDENCE_OK) {
            break;
          }
        }
      }
      const luma = (await recognize(await rotated(prepared.luma, best.degrees))).text;
      texts.push(luma, best.text);

      // La date de naissance est ce qui compte le plus (elle fixe la prime) :
      // tant qu'elle n'est pas validée par son chiffre de contrôle, la passe
      // dédiée à la bande est tentée.
      const hasBirthdate = (value: string) => Boolean(readMrz(value).fields.birthdate);
      if (mrzText) {
        continue;
      }
      const readable = [best.text, luma].find(hasBirthdate);
      if (readable) {
        mrzText = readable;
        continue;
      }
      await worker.setParameters({ tessedit_char_whitelist: MRZ_ALPHABET });
      try {
        const orientations = [best.degrees, ...[0, 180, 90, 270].filter((d) => d !== best.degrees)];
        for (const degrees of orientations) {
          const attempt = await recognize(await rotated(prepared.ink, degrees));
          if (hasBirthdate(attempt.text)) {
            mrzText = attempt.text;
            break;
          }
        }
      } finally {
        await worker.setParameters({ tessedit_char_whitelist: '' });
      }
    }

    // Les deux versions de chaque image se recoupent largement : les lignes
    // identiques ne sont gardées qu'une fois, pour ne pas alourdir ce qui
    // sera ensuite confié au modèle de langage.
    const seen = new Set<string>();
    const text = texts.join('\n').split('\n').filter((line) => {
      const key = line.trim();
      if (!key) {
        return true;
      }
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }).join('\n');
    return { text, mrzText };
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
  // Même ligne, et pas la fin d'une date (« 12.03.1985 ») : sans quoi une
  // année suivie de la ligne d'après passerait pour une adresse.
  const match = text.match(/(?<![\d.])\b([1-9]\d{3})[ \t]+([A-ZÄÖÜÉÈÀ][\wäöüéèàç'’-]{2,30}(?:[ \t][A-ZÄÖÜÉÈÀ][\wäöüéèàç'’-]{2,30})?)/);
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
    // Mot entier, et non simple sous-chaîne : « assura » se trouve dans
    // « assurance-maladie », ce qui faisait passer toute police française pour
    // un contrat Assura, quelle que soit la caisse réelle.
    .filter((candidate) => candidate.key.length >= 3 &&
      new RegExp(`(^|[^a-z0-9])${candidate.key}([^a-z0-9]|$)`).test(haystack));

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

// ------------------------------------------------------- pièce d'identité
//
// Une carte d'identité, un passeport ou un permis de séjour portent une bande
// lisible par machine (MRZ) normalisée par l'OACI. C'est de très loin la
// partie la plus sûre à reconnaître : police à chasse fixe, alphabet réduit,
// position fixe des champs, et surtout des chiffres de contrôle qui
// permettent de vérifier la lecture au lieu de l'espérer.
//
// Trois formats coexistent :
//   TD1 (carte d'identité, permis)  3 lignes de 30
//   TD2 (anciennes cartes)          2 lignes de 36
//   TD3 (passeport)                 2 lignes de 44

/** Poids cycliques 7-3-1 du calcul de contrôle OACI. */
const MRZ_WEIGHTS = [7, 3, 1];

function mrzCheckDigit(value: string): number {
  let sum = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    let digit: number;
    if (char >= '0' && char <= '9') {
      digit = char.charCodeAt(0) - 48;
    } else if (char >= 'A' && char <= 'Z') {
      digit = char.charCodeAt(0) - 55;
    } else {
      digit = 0; // '<' et tout le reste
    }
    sum += digit * MRZ_WEIGHTS[i % 3];
  }
  return sum % 10;
}

function mrzCheckOk(value: string, expected: string): boolean {
  return /^\d$/.test(expected) && mrzCheckDigit(value) === Number(expected);
}

/**
 * La reconnaissance optique confond systématiquement quelques caractères dans
 * la MRZ. Le format impose la nature de chaque position : on s'en sert pour
 * réparer plutôt que pour rejeter.
 */
const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', G: '6', Z: '2' };
const TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G' };

function asDigits(value: string): string {
  return value.replace(/./g, (c) => TO_DIGIT[c] ?? c);
}

function asLetters(value: string): string {
  return value.replace(/./g, (c) => TO_LETTER[c] ?? c);
}

/** Nettoie une ligne candidate : majuscules, chevrons, sans espaces parasites. */
function mrzClean(line: string): string {
  return line
    .toUpperCase()
    .replace(/[«»<>‹›]/g, '<')
    .replace(/[^A-Z0-9<]/g, '');
}

/**
 * Retrouve les lignes de la bande dans le texte reconnu.
 * On teste chaque format sur les lignes riches en chevrons, en s'autorisant
 * une tolérance de longueur : l'OCR ajoute ou perd volontiers un caractère.
 */
function findMrzLines(text: string): { format: 'TD1' | 'TD2' | 'TD3'; lines: string[] } | undefined {
  const candidates = text
    .split(/\r?\n/)
    .map(mrzClean)
    .filter((line) => line.length >= 28 && line.includes('<'));

  const formats: Array<{ format: 'TD1' | 'TD2' | 'TD3'; count: number; width: number }> = [
    { format: 'TD1', count: 3, width: 30 },
    { format: 'TD3', count: 2, width: 44 },
    { format: 'TD2', count: 2, width: 36 }
  ];

  for (const { format, count, width } of formats) {
    for (let i = 0; i + count <= candidates.length; i++) {
      const block = candidates.slice(i, i + count);
      if (block.every((line) => Math.abs(line.length - width) <= 2)) {
        // Recalé à la largeur exacte : les décalages fausseraient tous les champs.
        return { format, lines: block.map((line) => line.slice(0, width).padEnd(width, '<')) };
      }
    }
  }
  return undefined;
}

/** « 840512 » → 1984-05-12, le siècle étant déduit : une naissance est passée. */
function mrzBirthdate(raw: string): { iso: string; yymmdd: string } | undefined {
  const yymmdd = asDigits(raw);
  if (!/^\d{6}$/.test(yymmdd)) {
    return undefined;
  }

  const yy = Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }

  const nowYear = new Date().getUTCFullYear();
  const century = 2000 + yy > nowYear ? 1900 : 2000;
  const date = new Date(Date.UTC(century + yy, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== month - 1) {
    return undefined;
  }

  return { iso: date.toISOString().slice(0, 10), yymmdd };
}

/** « MUELLER<<HANS<PETER » → nom et prénoms. */
function mrzNames(field: string): { name?: string; firstname?: string } {
  const humanize = (value: string) => value
    .split('<')
    .filter(Boolean)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ')
    .trim();

  const [surname, given] = field.split('<<');
  return {
    name: humanize(surname || '') || undefined,
    firstname: humanize(given || '') || undefined
  };
}

/** Codes pays à trois lettres les plus courants sur les pièces présentées ici. */
const NATIONALITIES: Record<string, string> = {
  CHE: 'CH', DEU: 'DE', D: 'DE', FRA: 'FR', ITA: 'IT', AUT: 'AT', PRT: 'PT',
  ESP: 'ES', GBR: 'GB', BEL: 'BE', NLD: 'NL', POL: 'PL', TUR: 'TR', SRB: 'RS',
  HRV: 'HR', BIH: 'BA', XKX: 'XK', MKD: 'MK', ALB: 'AL', ROU: 'RO', BGR: 'BG',
  USA: 'US', BRA: 'BR', UKR: 'UA', RUS: 'RU'
};

/**
 * Lit la MRZ d'une pièce d'identité.
 *
 * Un champ n'est retenu que si son chiffre de contrôle concorde : mieux vaut
 * ne rien proposer qu'une date de naissance fausse d'un chiffre, qui
 * décalerait la tranche d'âge et donc toute la prime.
 */
function readMrz(text: string): {
  fields: Partial<ExtractionResult['fields']>;
  warnings: string[];
  /** Au moins un chiffre de contrôle concorde : la bande a vraiment été lue. */
  valid: boolean;
} {
  const found = findMrzLines(text);
  if (!found) {
    return { fields: {}, warnings: [], valid: false };
  }

  const { format, lines } = found;
  const fields: Partial<ExtractionResult['fields']> = {};
  const warnings: string[] = [];

  // Sans aucun chiffre de contrôle concordant, ce « bloc » n'est le plus
  // souvent que du bruit de reconnaissance mis en forme : noms et nationalité
  // qu'on en tirerait seraient inventés.
  const docLine = format === 'TD1' ? lines[0] : lines[1];
  const docStart = format === 'TD1' ? 5 : 0;
  const docValid = mrzCheckOk(docLine.slice(docStart, docStart + 9),
    asDigits(docLine.charAt(docStart + 9)));
  const birthData = format === 'TD1' ? lines[1].slice(0, 7) : lines[1].slice(13, 20);
  const birthValid = mrzCheckOk(asDigits(birthData.slice(0, 6)), asDigits(birthData.charAt(6)));
  if (!docValid && !birthValid) {
    return {
      fields: {},
      warnings: ['La bande de caractères de votre pièce a été repérée, mais pas lue de façon ' +
        'fiable : ses données n\'ont pas été reprises.'],
      valid: false
    };
  }

  // Positions du bloc « naissance / sexe / expiration / nationalité » et du
  // champ des noms, selon le format.
  //
  // TD1 place la naissance en tête de sa deuxième ligne ; TD2 et TD3 la font
  // suivre le numéro du document et la nationalité, avec la même disposition.
  const nameField = format === 'TD1' ? lines[2] : lines[0].slice(5);
  const data = lines[1];
  const td1 = format === 'TD1';
  const birthRaw = td1 ? data.slice(0, 6) : data.slice(13, 19);
  const birthCheck = td1 ? data.slice(6, 7) : data.slice(19, 20);
  const sexRaw = td1 ? data.slice(7, 8) : data.slice(20, 21);
  const nationRaw = td1 ? data.slice(15, 18) : data.slice(10, 13);

  const birth = mrzBirthdate(birthRaw);
  if (birth) {
    if (mrzCheckOk(birth.yymmdd, asDigits(birthCheck))) {
      fields.birthdate = { value: birth.iso, evidence: `MRZ ${birth.yymmdd}` };
    } else {
      warnings.push(
        'La date de naissance lue sur la bande de votre pièce ne passe pas son ' +
        'chiffre de contrôle : elle n\'a pas été reprise. Saisissez-la à la main.'
      );
    }
  }

  const sex = asLetters(sexRaw);
  if (sex === 'M' || sex === 'F') {
    fields.sexe = { value: sex, evidence: `MRZ ${sex}` };
  } else if (sex === 'X') {
    fields.sexe = { value: 'X', evidence: 'MRZ X' };
  }

  const nation = asLetters(nationRaw).replace(/</g, '');
  if (/^[A-Z]{3}$/.test(nation)) {
    fields.nationality = { value: NATIONALITIES[nation] || nation, evidence: `MRZ ${nation}` };
  }

  const names = mrzNames(nameField);
  if (names.name) {
    fields.name = { value: names.name, evidence: 'bande MRZ' };
  }
  if (names.firstname) {
    fields.firstname = { value: names.firstname, evidence: 'bande MRZ' };
  }

  return { fields, warnings, valid: true };
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
  let mrzText: string | undefined;
  try {
    ({ text, mrzText } = await readDocument(path, isPdf));
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
        ? 'Très peu de texte a été reconnu dans ce PDF : le scan est peut-être trop pâle ou de trop basse résolution.'
        : 'Très peu de texte a été reconnu sur l\'image.'
    );
  }

  const locality = findLocality(compact);
  const amounts = findAmounts(compact);
  const names = findNames(compact);

  // La bande MRZ passe en dernier et écrase le reste : ses champs sont
  // vérifiés par chiffre de contrôle, là où le texte libre est deviné.
  // Elle est cherchée dans le texte d'origine, ses lignes devant rester
  // entières — ou dans la passe qui lui a été dédiée, quand il a fallu une.
  const mrz = readMrz(mrzText ?? text);
  warnings.push(...mrz.warnings);

  const fields: ExtractionResult['fields'] = {
    avsNum: findAvs(compact),
    birthdate: findBirthdate(compact),
    provider: await findProvider(compact),
    policyNumber: findPolicyNumber(compact),
    ...locality,
    ...amounts,
    ...names,
    ...mrz.fields
  };

  if (!Object.values(fields).some(Boolean)) {
    warnings.push('Aucune donnée exploitable n\'a été reconnue : saisissez les informations à la main.');
  }

  return {
    source: isPdf ? 'PDF' : 'IMAGE',
    characters: compact.trim().length,
    text: compact,
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
    sexe: 'sexe',
    nationality: 'nationalité',
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
