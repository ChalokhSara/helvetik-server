import { IInsurance, PAYMENTS_PER_YEAR, PremiumFrequency } from '../models/insurance.model';
import { IClient } from '../models/client.model';

/**
 * Normalisation du corps JSON décrivant une assurance.
 * Les règles de fond (énumérations, champs obligatoires, bornes) restent
 * portées par le schéma Mongoose : on ne traite ici que ce qu'il ne voit pas,
 * c'est-à-dire le typage des dates et des nombres venus du JSON.
 */

export interface InsurancePayload {
  clientUid: string;
  provider: string;
  productName: string;
  type: string;
  description?: string;
  policyNumber: string;
  startDate: Date;
  endDate: Date;
  status?: string;
  premiumAmount?: number;
  premiumFrequency?: string;
  currency?: string;
  franchise?: number;
  coverageAmount?: number;
  cancellationNoticeMonths?: number;
  autoRenew?: boolean;
  employerAccidentCoverage?: boolean;
  tariffType?: string;
  tariffCode?: string;
  notes?: string;
}

export interface InsurancePayloadResult {
  values?: InsurancePayload;
  error?: string;
}

/**
 * Règles propres à l'assurance de base, imposées par la LAMal et non
 * négociables : le contrat court sur l'année civile et s'achève au 31 décembre,
 * il se reconduit tacitement, et le préavis de résiliation ordinaire est d'un
 * mois — la résiliation doit donc parvenir à la caisse pour le 30 novembre.
 *
 * Ces valeurs sont calculées plutôt que saisies : les demander à l'assuré,
 * c'est l'exposer à se tromper sur des dates qui ne dépendent pas de lui.
 */
export function applyLamalRules<T extends {
  type?: string;
  startDate?: Date;
  endDate?: Date;
  cancellationNoticeMonths?: number;
  autoRenew?: boolean;
}>(values: T, now = new Date()): T {
  if (values.type !== 'LAMAL') {
    return values;
  }

  // Période en cours : l'année civile courante, ou celle du début pour un
  // contrat qui ne prend effet que plus tard.
  const startYear = values.startDate?.getUTCFullYear() ?? now.getUTCFullYear();
  const year = Math.max(startYear, now.getUTCFullYear());

  values.endDate = new Date(Date.UTC(year, 11, 31));
  values.cancellationNoticeMonths = 1;
  values.autoRenew = true;
  return values;
}

/** Terme de la période LAMal en cours, pour l'afficher dans les formulaires. */
export function lamalPeriodEnd(startDate?: Date, now = new Date()): Date {
  const startYear = startDate?.getUTCFullYear() ?? now.getUTCFullYear();
  return new Date(Date.UTC(Math.max(startYear, now.getUTCFullYear()), 11, 31));
}

/** Nombre optionnel : absent reste absent, une saisie non numérique est une erreur. */
function readNumber(raw: unknown, label: string): { value?: number; error?: string } {
  if (raw === undefined || raw === null || raw === '') {
    return {};
  }
  const value = Number(raw);
  return Number.isFinite(value) ? { value } : { error: `${label} doit être un nombre.` };
}

export function readInsurancePayload(body: unknown): InsurancePayloadResult {
  if (!body || typeof body !== 'object') {
    return { error: 'Les données de l\'assurance sont manquantes.' };
  }

  const source = body as Record<string, unknown>;
  const str = (key: string) => String(source[key] ?? '').trim();

  const rawStart = str('startDate');
  if (!rawStart) {
    return { error: 'La date de début est obligatoire.' };
  }
  const startDate = new Date(rawStart);
  if (Number.isNaN(startDate.getTime())) {
    return { error: 'La date de début est invalide.' };
  }

  const type = str('type').toUpperCase();
  const isLamal = type === 'LAMAL';

  // Pour la LAMal, le terme est imposé par la loi : il n'est ni demandé ni lu.
  const rawEnd = str('endDate');
  let endDate: Date;
  if (isLamal) {
    endDate = lamalPeriodEnd(startDate);
  } else {
    if (!rawEnd) {
      return { error: 'La date de fin est obligatoire.' };
    }
    endDate = new Date(rawEnd);
    if (Number.isNaN(endDate.getTime())) {
      return { error: 'La date de fin est invalide.' };
    }
  }

  const numbers = {
    premiumAmount: readNumber(source.premiumAmount, 'La prime'),
    franchise: readNumber(source.franchise, 'La franchise'),
    coverageAmount: readNumber(source.coverageAmount, 'La somme assurée'),
    cancellationNoticeMonths: readNumber(source.cancellationNoticeMonths, 'Le préavis')
  };

  const numberError = Object.values(numbers).find((n) => n.error)?.error;
  if (numberError) {
    return { error: numberError };
  }

  const values: InsurancePayload = {
    clientUid: str('clientUid'),
    provider: str('provider'),
    productName: str('productName'),
    type,
    description: str('description') || undefined,
    policyNumber: str('policyNumber'),
    startDate,
    endDate,
    status: str('status').toUpperCase() || undefined,
    premiumAmount: numbers.premiumAmount.value,
    premiumFrequency: str('premiumFrequency').toUpperCase() || undefined,
    // Le franc est la seule devise en jeu et le formulaire du site ne la
    // demande pas. Sans valeur par défaut ici, une modification effacerait un
    // champ obligatoire et l'enregistrement échouerait.
    currency: str('currency').toUpperCase() || 'CHF',
    franchise: numbers.franchise.value,
    // La somme assurée n'a pas de sens pour une assurance de base.
    coverageAmount: isLamal ? undefined : numbers.coverageAmount.value,
    cancellationNoticeMonths: numbers.cancellationNoticeMonths.value,
    autoRenew: source.autoRenew === undefined ? undefined : Boolean(source.autoRenew),
    // Modèle et couverture accident ne concernent que la LAMal.
    employerAccidentCoverage: isLamal
      ? Boolean(source.employerAccidentCoverage)
      : undefined,
    tariffType: isLamal ? (str('tariffType').toUpperCase() || undefined) : undefined,
    tariffCode: isLamal ? (str('tariffCode') || undefined) : undefined,
    notes: str('notes') || undefined
  };

  return { values: applyLamalRules(values) };
}

/** Prime ramenée au mois, pour additionner des contrats de périodicités différentes. */
export function monthlyPremium(amount: number, frequency: PremiumFrequency): number {
  return (amount * PAYMENTS_PER_YEAR[frequency]) / 12;
}

/**
 * Date limite de résiliation, déduite du terme et du préavis contractuel.
 * Sans préavis renseigné, il n'y a rien à calculer.
 *
 * Le recul de mois est fait à la main plutôt qu'avec `setMonth`, qui déborde
 * sur le mois suivant quand le jour n'existe pas dans le mois cible : un terme
 * au 31.12 avec un mois de préavis donnerait le 1er décembre au lieu du
 * 30 novembre, soit une échéance annoncée plus tard qu'elle ne l'est.
 * Tout se calcule en UTC, comme les dates stockées.
 */
export function cancellationDeadline(insurance: IInsurance): Date | undefined {
  if (!insurance.endDate || !insurance.cancellationNoticeMonths) {
    return undefined;
  }

  const end = new Date(insurance.endDate);
  const day = end.getUTCDate();
  const target = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth() - insurance.cancellationNoticeMonths,
    1,
    end.getUTCHours(),
    end.getUTCMinutes()
  ));

  // Jour 0 du mois suivant = dernier jour du mois courant.
  const lastDayOfTargetMonth = new Date(Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    0
  )).getUTCDate();

  target.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return target;
}

export interface InsuredSummary {
  uid: string;
  name: string;
  firstname: string;
}

/**
 * Représentation renvoyée à l'application mobile. L'assuré est inclus sous
 * forme résumée : sans lui, une liste couvrant tout le foyer est illisible.
 */
export function serializeInsurance(insurance: IInsurance, client?: IClient) {
  return {
    uid: insurance.uid,
    provider: insurance.provider,
    productName: insurance.productName,
    type: insurance.type,
    description: insurance.description,
    policyNumber: insurance.policyNumber,
    startDate: insurance.startDate,
    endDate: insurance.endDate,
    status: insurance.status,
    premiumAmount: insurance.premiumAmount,
    premiumFrequency: insurance.premiumFrequency,
    currency: insurance.currency,
    monthlyPremium: Number(
      monthlyPremium(insurance.premiumAmount, insurance.premiumFrequency).toFixed(2)
    ),
    franchise: insurance.franchise,
    coverageAmount: insurance.coverageAmount,
    cancellationNoticeMonths: insurance.cancellationNoticeMonths,
    cancellationDeadline: cancellationDeadline(insurance),
    autoRenew: insurance.autoRenew,
    employerAccidentCoverage: insurance.employerAccidentCoverage,
    tariffType: insurance.tariffType,
    tariffCode: insurance.tariffCode,
    insurerId: insurance.insurerId,
    notes: insurance.notes,
    insured: client
      ? { uid: client.uid, name: client.name, firstname: client.firstname }
      : { uid: insurance.clientUid }
  };
}
