import { TariffType } from '../models/premium.model';
import { activeYear } from './premium-import.service';
import {
  ComputedOffer,
  computeOffers,
  PremiumAmounts,
  resolveInsurerByName,
  resolveRegion
} from './premium-query.service';
import { HouseholdContext, HouseholdError, InsuredSummary } from './household.service';

/**
 * Optimisation LAMal à partir des données officielles importées.
 * Partagée par l'API mobile et le site web.
 */

/** Meilleure offre pour un assuré pris isolément. */
export interface IndividualPlan {
  ref: string;
  name: string;
  best: ComputedOffer;
  /** Le contrat actuel de la personne, au prorata de sa propre prime. */
  current: ComputedOffer | null;
  savings: { monthly: number; yearly: number };
}

export interface IndividualResult {
  plans: IndividualPlan[];
  monthly: PremiumAmounts;
  yearly: PremiumAmounts;
  savings: { monthly: number; yearly: number };
  /** Économie supplémentaire par rapport à la meilleure solution groupée. */
  extra: { monthly: number; yearly: number };
  /** Nombre de caisses distinctes à gérer si l'on suit cette répartition. */
  insurerCount: number;
}

export interface OptimisationResult {
  year: number;
  redistributionYearly: number;
  activatedAt?: Date;
  location: { label: string; canton: string; region: number; plz: string };
  insurer: { insurerId: number; name: string } | null;
  /** Hypothèses retenues pour chaque assuré, à afficher avec le résultat. */
  insured: InsuredSummary[];
  offers: ComputedOffer[];
  current: ComputedOffer | null;
  potentialSavings: { monthly: number; yearly: number };
  /**
   * Répartition optimale, chaque assuré chez la caisse la moins chère pour lui.
   * `null` pour une personne seule, où les deux calculs se confondent.
   */
  individual: IndividualResult | null;
  warnings: string[];
}

/** Le dictionnaire de l'OFSP ne nomme que les modèles alternatifs. */
export function modelLabel(offer: ComputedOffer): string {
  return offer.tariffName || (offer.tariffType === 'BASE' ? 'Assurance de base' : offer.tariffCode);
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Calcule la meilleure offre de chaque assuré pris séparément.
 *
 * Le classement groupé impose une seule caisse et un seul modèle à tout le
 * foyer : une offre n'y figure que si elle existe pour chacun. Cette contrainte
 * ne peut qu'écarter des possibilités, jamais en ajouter — la répartition
 * individuelle est donc toujours inférieure ou égale au meilleur total groupé.
 * Rien ne s'y oppose en LAMal, où les primes sont réglementées et strictement
 * individuelles : il n'existe aucun rabais de contrat familial.
 *
 * Le calcul se fait en rejouant le classement pour chaque personne seule, afin
 * de n'avoir qu'un seul moteur de primes à maintenir et à valider.
 */
async function optimiseIndividually(
  context: HouseholdContext,
  household: { canton: string; region: number },
  current: { insurerId: number; tariffCode?: string } | undefined,
  models?: string[]
): Promise<IndividualResult | null> {
  const plans: IndividualPlan[] = [];

  for (const person of context.insured) {
    const computed = await computeOffers({
      canton: household.canton,
      region: household.region,
      insured: [{
        ref: person.clientUid,
        age: person.age,
        franchise: person.franchise,
        withAccident: person.coverage === 1
      }],
      tariffTypes: models as TariffType[] | undefined,
      current
    });

    // Un assuré sans aucune offre rendrait le total faux : mieux vaut ne rien
    // proposer que d'afficher une répartition amputée d'une personne.
    if (!computed || !computed.offers.length) {
      return null;
    }

    const best = computed.offers[0];
    plans.push({
      ref: person.clientUid,
      name: person.name,
      best,
      current: computed.current,
      savings: computed.current
        ? {
            monthly: round(computed.current.monthly.total - best.monthly.total),
            yearly: round(computed.current.yearly.total - best.yearly.total)
          }
        : { monthly: 0, yearly: 0 }
    });
  }

  const sum = (pick: (plan: IndividualPlan) => number) =>
    round(plans.reduce((total, plan) => total + pick(plan), 0));

  const monthly: PremiumAmounts = {
    premium: sum((p) => p.best.monthly.premium),
    redistribution: sum((p) => p.best.monthly.redistribution),
    total: sum((p) => p.best.monthly.total)
  };

  return {
    plans,
    monthly,
    yearly: {
      premium: round(monthly.premium * 12),
      redistribution: round(monthly.redistribution * 12),
      total: round(monthly.total * 12)
    },
    savings: {
      monthly: sum((p) => p.savings.monthly),
      yearly: sum((p) => p.savings.yearly)
    },
    extra: { monthly: 0, yearly: 0 },
    insurerCount: new Set(plans.map((plan) => plan.best.insurerId)).size
  };
}

/**
 * Calcule le classement des offres pour un foyer.
 * Renvoie `null` si aucune année de primes n'est en service.
 */
export async function optimiseLamal(
  context: HouseholdContext,
  options: { models?: string[] } = {}
): Promise<OptimisationResult | null> {
  const year = await activeYear();
  if (!year) {
    return null;
  }

  const warnings = [...context.warnings];

  const region = await resolveRegion(year.year, context.reference.plz, context.reference.location);
  if (!region) {
    throw new HouseholdError(400, 'LOCATION_REQUIRED',
      `Le NPA ${context.reference.plz} est introuvable dans les régions de primes ${year.year}.`);
  }
  if (region.ambiguous) {
    warnings.push(
      `Le NPA ${context.reference.plz} couvre plusieurs régions de primes ; « ${region.label} » a été retenue.`
    );
  }

  if (!context.currentProvider) {
    throw new HouseholdError(400, 'CURRENT_LAMAL_REQUIRED',
      'La comparaison se fait par rapport à votre contrat actuel : enregistrez une assurance LAMal en vigueur.');
  }

  const insurer = await resolveInsurerByName(year.year, context.currentProvider);
  if (!insurer) {
    warnings.push(
      `La caisse « ${context.currentProvider} » n'a pas été reconnue parmi les assureurs LAMal : ` +
      'les économies ne peuvent pas être calculées par rapport à votre contrat.'
    );
  } else if (!context.currentTariffCode) {
    warnings.push(
      'Le modèle de votre contrat n\'est pas enregistré : la comparaison prend le modèle standard ' +
      'comme référence. Renseignez-le pour une économie exacte.'
    );
  }

  const computed = await computeOffers({
    canton: region.canton,
    region: region.region,
    insured: context.insured.map((person) => ({
      ref: person.clientUid,
      age: person.age,
      franchise: person.franchise,
      withAccident: person.coverage === 1
    })),
    tariffTypes: options.models as TariffType[] | undefined,
    current: insurer
      ? { insurerId: insurer.insurerId, tariffCode: context.currentTariffCode }
      : undefined
  });

  if (!computed || !computed.offers.length) {
    throw new HouseholdError(404, 'NO_PREMIUM_DATA',
      `Aucune prime ${year.year} ne correspond à ce foyer dans les données officielles.`);
  }

  // Ne jamais substituer le modèle standard en silence : l'économie affichée
  // serait surestimée sans que rien ne le signale.
  if (context.currentTariffCode && computed.currentMatch === 'FALLBACK_BASE') {
    warnings.push(
      `Le modèle « ${context.currentTariffCode} » n'existe pas au catalogue de votre caisse pour ` +
      'cette région : la comparaison prend le modèle standard comme référence, ce qui surestime ' +
      'l\'économie. Corrigez le modèle sur votre contrat.'
    );
  }

  const best = computed.offers[0];

  // Pour une personne seule, les deux calculs donnent le même résultat : on
  // n'affiche pas deux fois la même liste.
  const individual = context.insured.length > 1
    ? await optimiseIndividually(
        context,
        { canton: region.canton, region: region.region },
        insurer ? { insurerId: insurer.insurerId, tariffCode: context.currentTariffCode } : undefined,
        options.models
      )
    : null;

  if (individual) {
    individual.extra = {
      monthly: Math.max(0, round(best.monthly.total - individual.monthly.total)),
      yearly: Math.max(0, round(best.yearly.total - individual.yearly.total))
    };
  }

  return {
    year: computed.year,
    redistributionYearly: computed.redistributionYearly,
    activatedAt: year.activatedAt,
    location: {
      label: region.label,
      canton: region.canton,
      region: region.region,
      plz: context.reference.plz
    },
    insurer,
    insured: context.insured,
    offers: computed.offers,
    current: computed.current,
    potentialSavings: computed.current
      ? {
          monthly: Math.max(0, round(computed.current.monthly.total - best.monthly.total)),
          yearly: Math.max(0, round(computed.current.yearly.total - best.yearly.total))
        }
      : { monthly: 0, yearly: 0 },
    individual,
    warnings
  };
}
