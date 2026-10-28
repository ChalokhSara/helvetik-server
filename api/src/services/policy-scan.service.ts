import { Client } from '../models/client.model';
import { InsuranceType, PremiumFrequency } from '../models/insurance.model';
import { analyseText, extractFromDocument, ExtractionResult } from './document-extraction.service';
import { readAnyPolicy, readPolicy } from './policy-llm.service';
import { catalogueFor } from './premium-catalogue.service';
import { ageAt, matchInsured } from './household.service';

/**
 * Lecture d'une police déposée depuis l'application mobile, tous types
 * d'assurance confondus.
 *
 * Trois lectures superposées, de la plus générale à la plus sûre :
 *
 *   1. les motifs textuels, toujours, comme filet si le modèle est absent ;
 *   2. le modèle de langage local, toujours lui aussi : il lit tout type de
 *      police et ses réponses sont recoupées avec le texte du document ;
 *   3. pour une police LAMal, la lecture spécialisée, validée contre le
 *      catalogue officiel de la région — elle a le dernier mot sur la caisse,
 *      le modèle, la franchise et la prime.
 *
 * Rien n'est enregistré : le résultat est un brouillon que l'assuré vérifie.
 */

export interface PolicyDraft {
  type?: InsuranceType;
  clientUid?: string;
  provider?: string;
  productName?: string;
  policyNumber?: string;
  startDate?: string;
  endDate?: string;
  premiumAmount?: number;
  premiumFrequency?: PremiumFrequency;
  franchise?: number;
  coverageAmount?: number;
  cancellationNoticeMonths?: number;
  tariffCode?: string;
  insurerId?: number;
  employerAccidentCoverage?: boolean;
  description?: string;
}

export interface PolicyScan {
  draft: PolicyDraft;
  recognised: string[];
  warnings: string[];
  source: ExtractionResult['source'];
  characters: number;
  /** Le modèle de langage a-t-il pu lire le document ? */
  assisted: boolean;
}

/**
 * Indices de type, dans les trois langues que l'on rencontre sur une police.
 * Repli seulement, quand le modèle de langage ne répond pas. L'ordre compte :
 * une complémentaire mentionne souvent la LAMal, et une police véhicule parle
 * aussi de responsabilité civile. Le plus spécifique passe donc en premier.
 */
const TYPE_HINTS: Array<[InsuranceType, RegExp]> = [
  ['VEHICULE', /\b(v[ée]hicule|motorfahrzeug|auto(mobile)?versicherung|casco|kasko|plaques?\s+de\s+contr[ôo]le|immatriculation)\b/i],
  ['ANIMAUX', /\b(animal|animaux|tierversicherung|chien|chat|hund|katze)\b/i],
  ['VOYAGE', /\b(voyage|reiseversicherung|assistance\s+voyage|annulation\s+de\s+voyage)\b/i],
  ['PROTECTION_JURIDIQUE', /\b(protection\s+juridique|rechtsschutz|protezione\s+giuridica)\b/i],
  ['BATIMENT', /\b(b[âa]timent|geb[äa]ude|immeuble|propri[ée]taire\s+d.immeuble)\b/i],
  ['MENAGE', /\b(m[ée]nage|hausrat|mobilia\s+domestica|inventaire)\b/i],
  ['RC_PRIVEE', /\b(responsabilit[ée]\s+civile|privathaftpflicht|haftpflicht|\bRC\s+priv[ée]e)\b/i],
  ['VIE', /\b(assurance[- ]vie|lebensversicherung|3e\s+pilier|pilier\s+3[ab]|s[äa]ule\s+3[ab])\b/i],
  ['INDEMNITE_JOURNALIERE', /\b(indemnit[ée]s?\s+journali[èe]res?|taggeld|perte\s+de\s+gain)\b/i],
  ['COMPLEMENTAIRE_SANTE', /\b(compl[ée]mentaire|zusatzversicherung|LCA|VVG|hospitalisation|division\s+(priv[ée]e|demi-priv[ée]e)|dentaire)\b/i],
  ['LAMAL', /\b(LAMal|KVG|assurance\s+obligatoire\s+des\s+soins|obligatorische\s+krankenpflege|assurance\s+de\s+base|grundversicherung|franchise)\b/i],
  ['ACCIDENT', /\b(accident|unfall|infortuni|LAA|UVG)\b/i]
];

export function guessInsuranceType(text: string): InsuranceType | undefined {
  for (const [type, pattern] of TYPE_HINTS) {
    if (pattern.test(text)) {
      return type;
    }
  }
  return undefined;
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value.replace(/['’\s]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Lit un document et en tire un brouillon de contrat.
 *
 * `requestedType` laisse l'assuré trancher quand il sait ce qu'il dépose :
 * il prime sur le type lu par le modèle.
 */
export async function scanPolicy(options: {
  userUid: string;
  path: string;
  mimetype: string;
  filename: string;
  requestedType?: InsuranceType;
}): Promise<PolicyScan> {
  const result = await extractFromDocument(options.path, options.mimetype, options.filename);
  return analysePolicy(result, options);
}

/**
 * Même lecture, à partir du texte reconnu sur le téléphone. Plus rapide —
 * ni téléversement d'image, ni reconnaissance optique côté serveur — et plus
 * juste : la reconnaissance du téléphone abîme bien moins une photo.
 */
export async function scanPolicyText(options: {
  userUid: string;
  text: string;
  requestedType?: InsuranceType;
}): Promise<PolicyScan> {
  const result = await analyseText(options.text, { source: 'TEXT' });
  return analysePolicy(result, options);
}

async function analysePolicy(
  result: ExtractionResult,
  options: { userUid: string; requestedType?: InsuranceType }
): Promise<PolicyScan> {
  const warnings = [...result.warnings];
  const recognised: string[] = [];
  const fields = result.fields;

  // 1. Motifs textuels : le filet de sécurité.
  const draft: PolicyDraft = {
    provider: fields.provider?.value,
    policyNumber: fields.policyNumber?.value,
    premiumAmount: toNumber(fields.premiumAmount?.value),
    franchise: toNumber(fields.franchise?.value)
  };

  // 2. Modèle de langage, sur tout document.
  const reading = await readAnyPolicy(result.text);
  if (reading) {
    warnings.push(...reading.warnings);
    recognised.push(...reading.recognised);
    // Ce que le modèle a lu, et que le texte confirme, prime sur les motifs.
    for (const key of [
      'provider', 'productName', 'policyNumber', 'startDate', 'endDate', 'premiumAmount',
      'premiumFrequency', 'franchise', 'coverageAmount', 'cancellationNoticeMonths'
    ] as const) {
      if (reading[key] !== undefined) {
        (draft as Record<string, unknown>)[key] = reading[key];
      }
    }
    if (reading.notes) {
      draft.description = reading.notes;
    }
  } else if (result.text.trim().length >= 40) {
    warnings.push(
      'La lecture par l\'IA n\'a pas abouti : seuls les éléments les plus simples ont été ' +
      'repris. Vérifiez chaque champ.'
    );
  }

  const guessed = reading?.type ?? guessInsuranceType(result.text);
  const type = options.requestedType || guessed;
  draft.type = type;
  if (!reading && guessed && !options.requestedType) {
    recognised.push('type de contrat');
  }
  if (!reading) {
    if (draft.provider) { recognised.push('prestataire'); }
    if (draft.policyNumber) { recognised.push('n° de police'); }
    if (draft.premiumAmount !== undefined) { recognised.push('prime'); }
  }
  // La franchise n'a de sens que pour les assurances maladie.
  if (type !== 'LAMAL' && type !== 'COMPLEMENTAIRE_SANTE' && !reading?.franchise) {
    draft.franchise = undefined;
  }

  let avsNum = fields.avsNum?.value || reading?.avsNum;
  let insuredName = reading?.insuredName;
  let insuredBirthdate = reading?.insuredBirthdate;

  // 3. LAMal : la lecture validée contre le catalogue officiel a le dernier mot.
  if (type === 'LAMAL') {
    const reference = await Client.findOne({ userUid: options.userUid }).sort({ birthdate: 1 });
    const catalogue = reference ? await catalogueFor(reference.plz, reference.location) : null;

    if (catalogue) {
      const age = reference?.birthdate ? ageAt(reference.birthdate, new Date()) : undefined;
      const lamal = await readPolicy(result.text, catalogue, age);
      if (lamal) {
        warnings.push(...lamal.warnings);
        recognised.push(...lamal.recognised);
        draft.insurerId = lamal.insurerId;
        draft.provider = lamal.insurerName ?? draft.provider;
        draft.tariffCode = lamal.tariffCode;
        draft.productName = lamal.tariffLabel ?? draft.productName;
        draft.franchise = lamal.franchise ?? draft.franchise;
        // La prime de base seule, mensuelle : le total lu plus haut peut
        // inclure la complémentaire.
        if (lamal.premiumAmount !== undefined) {
          draft.premiumAmount = lamal.premiumAmount;
          draft.premiumFrequency = 'MENSUEL';
        }
        draft.policyNumber = lamal.policyNumber ?? draft.policyNumber;
        draft.employerAccidentCoverage = lamal.employerAccidentCoverage;
        draft.startDate = lamal.startDate ?? draft.startDate;
        draft.description = lamal.notes ?? draft.description;
        avsNum = avsNum || lamal.avsNum;
        insuredName = lamal.insuredName ?? insuredName;
        insuredBirthdate = lamal.insuredBirthdate ?? insuredBirthdate;
      }
    } else {
      warnings.push(
        'Les primes officielles ne sont pas encore importées sur le serveur : la caisse et ' +
        'le modèle LAMal n\'ont pas pu être vérifiés contre le catalogue de l\'OFSP.'
      );
    }
  }

  // Rattachement à une personne du foyer, du repère le plus sûr au plus souple.
  if (avsNum) {
    const match = await Client.findOne({ userUid: options.userUid, avsNum });
    if (match) {
      draft.clientUid = match.uid;
      recognised.push('assuré');
    }
  }
  if (!draft.clientUid && (insuredName || insuredBirthdate)) {
    const match = await matchInsured(options.userUid, insuredName, insuredBirthdate);
    if (match) {
      draft.clientUid = match.uid;
      recognised.push('assuré');
    }
  }
  if (!draft.clientUid) {
    const clients = await Client.find({ userUid: options.userUid }).select('uid');
    if (clients.length === 1) {
      draft.clientUid = clients[0].uid;
    }
  }

  // La lecture du document le signale déjà quand elle ne trouve rien : ne
  // l'annoncer qu'une fois.
  if (!recognised.length && !warnings.some((w) => /saisi(ssez|r) .*à la main/.test(w))) {
    warnings.push('Rien n\'a pu être reconnu automatiquement : saisissez le contrat à la main.');
  }

  return {
    draft,
    recognised: [...new Set(recognised)],
    warnings,
    source: result.source,
    characters: result.characters,
    assisted: Boolean(reading)
  };
}
