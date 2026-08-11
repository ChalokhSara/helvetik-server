import { Client, IClient } from '../models/client.model';
import { IInsurance, Insurance } from '../models/insurance.model';

/**
 * Traduit un foyer en critères de comparaison de primes.
 *
 * Partagé par l'API mobile et le site web : les règles de franchise légale et
 * d'inversion de la couverture accident ne doivent exister qu'à un seul
 * endroit, sous peine de diverger silencieusement d'un canal à l'autre.
 */

/** Franchises LAMal légales, distinctes pour les adultes et les enfants. */
export const ADULT_FRANCHISES = [300, 500, 1000, 1500, 2000, 2500];
export const CHILD_FRANCHISES = [0, 100, 200, 300, 400, 500, 600];

/** Au-delà, priminfo ne suit plus et l'URL devient ingérable. */
export const MAX_INSURED = 9;
const ADULT_FROM_AGE = 19;

export interface InsuredSummary {
  clientUid: string;
  name: string;
  yob: number;
  age: number;
  franchise: number;
  franchiseSource: string;
  employerAccidentCoverage: boolean;
  /** 1 = couverture accident incluse dans la LAMal, 0 = couverte par l'employeur. */
  coverage: number;
  coverageSource: string;
}

export interface HouseholdContext {
  reference: IClient;
  selected: IClient[];
  insured: InsuredSummary[];
  /** Prestataire du contrat LAMal servant de référence, s'il y en a un. */
  currentProvider?: string;
  /** Modèle exact du contrat, quand il est enregistré. */
  currentTariffCode?: string;
  currentProviderHolder?: IClient;
  warnings: string[];
}

export interface HouseholdOptions {
  /** Restreint la comparaison à certains assurés. */
  clientUids?: string[];
  /** Force la couverture accident pour tous : '0' ou '1'. */
  coverageOverride?: string;
}

export const PHONE_REQUIRED_MESSAGE =
  'Le téléphone est obligatoire pour le premier assuré du compte : il en est le contact.';

/**
 * Le premier assuré d'un compte en est le titulaire, et son téléphone sert de
 * contact au dossier. Les suivants — enfant, conjoint — n'en ont pas forcément.
 *
 * La règle vit ici plutôt que dans le schéma Mongoose, qui valide un document
 * isolément et ne peut pas savoir combien d'assurés le compte possède déjà.
 * Tous les chemins de création s'y réfèrent : inscription, ajout depuis le
 * site, API mobile et console d'administration.
 */
export async function isFirstClientOfHousehold(userUid: string): Promise<boolean> {
  return !(await Client.exists({ userUid }));
}

export function ageAt(birthdate: Date, reference: Date): number {
  let age = reference.getUTCFullYear() - birthdate.getUTCFullYear();
  const monthDiff = reference.getUTCMonth() - birthdate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && reference.getUTCDate() < birthdate.getUTCDate())) {
    age--;
  }
  return age;
}

/**
 * Ramène une franchise à une valeur légale pour la tranche d'âge : celle
 * stockée peut venir d'une saisie libre, ou avoir été prise quand l'assuré
 * était encore un enfant.
 */
export function nearestLegalFranchise(value: number | undefined, isChild: boolean): number {
  const allowed = isChild ? CHILD_FRANCHISES : ADULT_FRANCHISES;
  if (value === undefined || value === null) {
    return isChild ? 0 : 300;
  }
  if (allowed.includes(value)) {
    return value;
  }
  return allowed.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best
  );
}

export class HouseholdError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function buildHouseholdContext(
  userUid: string,
  options: HouseholdOptions = {}
): Promise<HouseholdContext> {
  const warnings: string[] = [];

  const filter: Record<string, unknown> = { userUid };
  if (options.clientUids?.length) {
    filter.uid = { $in: options.clientUids };
  }

  const clients: IClient[] = await Client.find(filter).sort({ birthdate: 1 });
  if (!clients.length) {
    throw new HouseholdError(404, 'NO_INSURED', options.clientUids?.length
      ? 'Aucun de ces assurés n\'appartient à votre foyer.'
      : 'Aucun assuré dans ce foyer.');
  }

  let selected = clients;
  if (selected.length > MAX_INSURED) {
    warnings.push(
      `La comparaison n'accepte que ${MAX_INSURED} personnes : seuls les ${MAX_INSURED} premiers assurés ont été repris.`
    );
    selected = selected.slice(0, MAX_INSURED);
  }

  const lamal: IInsurance[] = await Insurance.find({
    userUid,
    clientUid: { $in: selected.map((c) => c.uid) },
    type: 'LAMAL',
    status: 'ACTIVE'
  });
  const lamalByClient = new Map(lamal.map((i) => [i.clientUid, i]));

  const reference = selected[0];
  if (selected.some((c) => c.plz !== reference.plz)) {
    warnings.push(
      `Tous les assurés n'ont pas le même NPA ; celui de ${reference.firstname} ${reference.name} (${reference.plz}) a été retenu.`
    );
  }

  const now = new Date();
  const insured = selected.map((client) => {
    const contract = lamalByClient.get(client.uid);
    const age = ageAt(client.birthdate, now);
    const isChild = age < ADULT_FROM_AGE;
    const franchise = nearestLegalFranchise(contract?.franchise, isChild);

    if (contract?.franchise !== undefined && contract.franchise !== franchise) {
      warnings.push(
        `La franchise de ${client.firstname} ${client.name} (${contract.franchise}) n'est pas une franchise légale ` +
        `pour son âge ; ${franchise} a été utilisée.`
      );
    }
    if (!contract) {
      warnings.push(
        `Aucun contrat LAMal en vigueur pour ${client.firstname} ${client.name} : franchise par défaut de ${franchise}.`
      );
    }

    // Attention à l'inversion : coverage=1 signifie que la LAMal inclut la
    // couverture accident, donc que l'employeur ne couvre pas.
    const coveredByEmployer = contract?.employerAccidentCoverage === true;
    const coverage = options.coverageOverride ?? (coveredByEmployer ? '0' : '1');

    return {
      clientUid: client.uid,
      name: `${client.firstname} ${client.name}`,
      yob: client.birthdate.getUTCFullYear(),
      age,
      franchise,
      franchiseSource: contract ? 'contrat' : 'défaut',
      employerAccidentCoverage: coveredByEmployer,
      coverage: Number(coverage),
      coverageSource: options.coverageOverride !== undefined
        ? 'paramètre'
        : contract ? 'contrat' : 'défaut'
    };
  });

  // Caisse de référence : celle de l'assuré principal, sinon celle de n'importe
  // quel membre du foyer — l'enfant peut porter le contrat, pas le parent.
  const holder = lamalByClient.has(reference.uid)
    ? reference
    : selected.find((client) => lamalByClient.has(client.uid));
  const contract = holder ? lamalByClient.get(holder.uid) : undefined;
  if (contract && holder && holder.uid !== reference.uid) {
    warnings.push(
      `La caisse actuelle a été reprise du contrat de ${holder.firstname} ${holder.name}, ` +
      `faute de contrat LAMal pour ${reference.firstname} ${reference.name}.`
    );
  }

  return {
    reference,
    selected,
    insured,
    currentProvider: contract?.provider,
    currentTariffCode: contract?.tariffCode,
    currentProviderHolder: holder,
    warnings
  };
}
