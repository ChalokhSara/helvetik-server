import { Client } from '../models/client.model';
import { InsuranceType } from '../models/insurance.model';
import { extractFromDocument, ExtractionResult } from './document-extraction.service';
import { readPolicy } from './policy-llm.service';
import { catalogueFor } from './premium-catalogue.service';
import { ageAt, matchInsured } from './household.service';

/**
 * Lecture d'une police déposée depuis l'application mobile, tous types
 * d'assurance confondus.
 *
 * Le site web ne lit que des polices LAMal ; l'application accepte aussi bien
 * une police ménage qu'une assurance voiture. Le type est donc deviné d'abord,
 * puis seule une police LAMal passe par la lecture assistée, la seule à
 * disposer d'un catalogue officiel contre lequel valider ce qui est lu. Pour
 * les autres, les motifs textuels suffisent : prestataire, n° de police, prime.
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
  premiumAmount?: number;
  franchise?: number;
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
}

/**
 * Indices de type, dans les trois langues que l'on rencontre sur une police.
 * L'ordre compte : une complémentaire mentionne souvent la LAMal, et une
 * police véhicule parle aussi de responsabilité civile. Le plus spécifique
 * passe donc en premier.
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
 * deviner n'est qu'un repli, et une erreur de type ferait passer une police
 * ménage par la lecture LAMal.
 */
export async function scanPolicy(options: {
  userUid: string;
  path: string;
  mimetype: string;
  filename: string;
  requestedType?: InsuranceType;
}): Promise<PolicyScan> {
  const result = await extractFromDocument(options.path, options.mimetype, options.filename);
  const warnings = [...result.warnings];
  const recognised: string[] = [];
  const fields = result.fields;

  const guessed = guessInsuranceType(result.text);
  const type = options.requestedType || guessed;
  if (!options.requestedType && guessed) {
    recognised.push('type de contrat');
  }

  const draft: PolicyDraft = {
    type,
    provider: fields.provider?.value,
    policyNumber: fields.policyNumber?.value,
    premiumAmount: toNumber(fields.premiumAmount?.value),
    franchise: type === 'LAMAL' || type === 'COMPLEMENTAIRE_SANTE'
      ? toNumber(fields.franchise?.value)
      : undefined
  };
  if (draft.provider) { recognised.push('prestataire'); }
  if (draft.policyNumber) { recognised.push('n° de police'); }
  if (draft.premiumAmount !== undefined) { recognised.push('prime'); }

  let avsNum = fields.avsNum?.value;
  let insuredName: string | undefined;
  let insuredBirthdate: string | undefined;

  if (type === 'LAMAL') {
    // Le catalogue de la région du foyer : c'est contre lui que la lecture
    // assistée est validée, sans quoi elle pourrait inventer une caisse.
    const reference = await Client.findOne({ userUid: options.userUid }).sort({ birthdate: 1 });
    const catalogue = reference ? await catalogueFor(reference.plz, reference.location) : null;

    if (catalogue) {
      const age = reference?.birthdate ? ageAt(reference.birthdate, new Date()) : undefined;
      const reading = await readPolicy(result.text, catalogue, age);
      if (reading) {
        warnings.push(...reading.warnings);
        recognised.push(...reading.recognised);
        draft.insurerId = reading.insurerId;
        draft.provider = reading.insurerName ?? draft.provider;
        draft.tariffCode = reading.tariffCode;
        draft.productName = reading.tariffLabel;
        draft.franchise = reading.franchise ?? draft.franchise;
        draft.premiumAmount = reading.premiumAmount ?? draft.premiumAmount;
        draft.policyNumber = reading.policyNumber ?? draft.policyNumber;
        draft.employerAccidentCoverage = reading.employerAccidentCoverage;
        draft.startDate = reading.startDate;
        draft.description = reading.notes;
        avsNum = avsNum || reading.avsNum;
        insuredName = reading.insuredName;
        insuredBirthdate = reading.insuredBirthdate;
      } else {
        warnings.push(
          'La lecture assistée n\'était pas disponible : vérifiez la caisse, le modèle et la franchise.'
        );
      }
    } else {
      warnings.push(
        'Les tarifs officiels ne sont pas disponibles pour votre région : la caisse et le ' +
        'modèle doivent être choisis à la main.'
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

  if (!recognised.length) {
    warnings.push('Rien n\'a pu être reconnu automatiquement : saisissez le contrat à la main.');
  }

  return {
    draft,
    recognised: [...new Set(recognised)],
    warnings,
    source: result.source,
    characters: result.characters
  };
}
