import {
  AgeClass,
  Premium,
  PremiumInsurer,
  PremiumRegion,
  PremiumYear,
  TariffType
} from '../models/premium.model';

/**
 * Calcul des primes depuis les données officielles importées.
 *
 * Remplace l'interrogation de la page priminfo : mêmes chiffres, sans
 * dépendre de la présentation d'un site tiers. Les résultats ont été validés
 * au centime près contre priminfo, classement compris.
 */

/** Seuils légaux des classes d'âge LAMal. */
const YOUNG_ADULT_FROM = 19;
const ADULT_FROM = 26;

/**
 * Sous-groupe retenu pour les enfants : K1 est le tarif normal. K3 à K5 sont
 * des rabais familiaux à partir du troisième enfant, que priminfo n'applique
 * pas non plus par défaut.
 */
const DEFAULT_CHILD_SUBGROUP = 'K1';

export function ageClassFor(age: number): AgeClass {
  if (age < YOUNG_ADULT_FROM) return 'KIN';
  if (age < ADULT_FROM) return 'JUG';
  return 'ERW';
}

export interface InsuredCriteria {
  /** Identifiant applicatif, repris tel quel dans le résultat. */
  ref: string;
  age: number;
  franchise: number;
  /** Couverture accident incluse dans la LAMal. */
  withAccident: boolean;
}

export interface PremiumAmounts {
  premium: number;
  redistribution: number;
  total: number;
}

export interface ComputedOffer {
  rank: number;
  insurerId: number;
  insurer: string;
  tariffType: TariffType;
  tariffCode: string;
  tariffName?: string;
  monthly: PremiumAmounts & { savings: number };
  yearly: PremiumAmounts & { savings: number };
  persons: Array<{ ref: string; monthly: PremiumAmounts; yearly: PremiumAmounts }>;
}

export interface ComputeInput {
  canton: string;
  region: number;
  insured: InsuredCriteria[];
  tariffTypes?: TariffType[];
  /** Contrat actuel, pour calculer les économies. */
  current?: { insurerId: number; tariffCode?: string };
}

export interface ComputeResult {
  year: number;
  redistributionYearly: number;
  offers: ComputedOffer[];
  current: ComputedOffer | null;
  /**
   * Comment le contrat de référence a été identifié. `FALLBACK_BASE` signale
   * que le modèle enregistré n'a pas été reconnu : l'économie affichée est
   * alors calculée par rapport au modèle standard, donc surestimée.
   */
  currentMatch: 'EXACT' | 'FALLBACK_BASE' | 'NONE';
}

/** Compare deux libellés de modèle sans se laisser arrêter par la ponctuation. */
function sameTariff(a: string, b: string): boolean {
  const key = (value: string) =>
    value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return key(a) === key(b) && key(a).length > 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Localité(s) correspondant à un NPA, pour l'année active. */
export async function resolveRegion(
  year: number,
  plz: string,
  locality?: string
): Promise<{ canton: string; region: number; label: string; ambiguous: boolean } | null> {
  const candidates = await PremiumRegion.find({ year, plz: plz.trim() });
  if (!candidates.length) {
    return null;
  }

  const wanted = (locality || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

  const match = wanted
    ? candidates.find((c) =>
        c.locality.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(wanted))
    : undefined;

  const chosen = match || candidates[0];
  // Deux localités d'un même NPA peuvent relever de régions différentes, donc
  // de primes différentes : l'ambiguïté doit remonter à l'appelant.
  const ambiguous = !match && candidates.length > 1 &&
    new Set(candidates.map((c) => `${c.canton}${c.region}`)).size > 1;

  return {
    canton: chosen.canton,
    region: chosen.region,
    label: `${chosen.plz} ${chosen.locality}`,
    ambiguous
  };
}

/** Retrouve un assureur par son nom, avec correspondance souple. */
export async function resolveInsurerByName(
  year: number,
  provider: string
): Promise<{ insurerId: number; name: string } | null> {
  const wanted = provider.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (!wanted) {
    return null;
  }

  const insurers = await PremiumInsurer.find({ year });
  const normalize = (value: string) =>
    value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  /**
   * Classement par qualité de correspondance.
   *
   * Le simple « contient » ne suffit pas : « Mutuel » est contenu aussi bien
   * dans « Mutuel Krankenversicherung AG » que dans « Mutuelle Neuchâteloise »,
   * et retenir le nom le plus court désignerait la mauvaise caisse. Une
   * correspondance sur un mot entier prime donc sur une correspondance partielle.
   */
  const startsWithWord = (haystack: string, needle: string) =>
    haystack.startsWith(needle) &&
    (haystack.length === needle.length || /[\s\-.]/.test(haystack[needle.length]));

  const score = (name: string): number => {
    const value = normalize(name);
    if (value === wanted) return 4;
    if (startsWithWord(value, wanted)) return 3;
    if (startsWithWord(wanted, value)) return 2;
    if (value.includes(wanted) || wanted.includes(value)) return 1;
    return 0;
  };

  const ranked = insurers
    .map((insurer) => ({ insurer, score: score(insurer.name) }))
    .filter((candidate) => candidate.score > 0)
    // À qualité égale, le nom le plus court est le plus générique.
    .sort((a, b) => b.score - a.score || a.insurer.name.length - b.insurer.name.length);

  if (!ranked.length) {
    return null;
  }

  const best = ranked[0].insurer;
  return { insurerId: best.insurerId, name: best.name };
}

/**
 * Modèles proposés par une caisse dans une région donnée, pour alimenter le
 * sélecteur de l'application et permettre à l'assuré d'enregistrer le sien.
 */
export async function listTariffs(
  year: number,
  insurerId: number,
  scope?: { canton?: string; region?: number }
): Promise<Array<{ tariffCode: string; tariffName?: string; tariffType: TariffType }>> {
  const filter: Record<string, unknown> = { year, insurerId };
  if (scope?.canton) filter.canton = scope.canton;
  if (scope?.region !== undefined) filter.region = scope.region;

  const rows = await Premium.find(filter).select('tariffCode tariffName tariffType');

  // Un tarif apparaît une fois par franchise, âge et couverture accident :
  // seule sa définition nous intéresse ici.
  const unique = new Map<string, { tariffCode: string; tariffName?: string; tariffType: TariffType }>();
  for (const row of rows) {
    if (!unique.has(row.tariffCode)) {
      unique.set(row.tariffCode, {
        tariffCode: row.tariffCode,
        tariffName: row.tariffName,
        tariffType: row.tariffType
      });
    }
  }

  return [...unique.values()].sort((a, b) =>
    a.tariffType.localeCompare(b.tariffType) ||
    (a.tariffName || a.tariffCode).localeCompare(b.tariffName || b.tariffCode));
}

/**
 * Calcule toutes les offres disponibles pour un foyer.
 *
 * Une offre n'est retenue que si elle existe pour **tous** les assurés : un
 * modèle proposé au parent mais pas à l'enfant ne constitue pas une solution
 * pour le foyer. C'est aussi la règle qu'applique priminfo.
 */
export async function computeOffers(input: ComputeInput): Promise<ComputeResult | null> {
  const year = await PremiumYear.findOne({ status: 'ACTIVE' });
  if (!year) {
    return null;
  }

  const monthlyRedistribution = year.redistributionYearly / 12;
  const tariffTypes = input.tariffTypes?.length
    ? input.tariffTypes
    : (['BASE', 'HAM', 'HMO', 'DIV'] as TariffType[]);

  const perPerson: Array<Map<string, { premium: number; type: TariffType; name?: string; insurerId: number; code: string }>> = [];

  for (const person of input.insured) {
    const ageClass = ageClassFor(person.age);
    const filter: Record<string, unknown> = {
      year: year.year,
      canton: input.canton,
      region: input.region,
      ageClass,
      franchise: person.franchise,
      withAccident: person.withAccident,
      tariffType: { $in: tariffTypes }
    };
    if (ageClass === 'KIN') {
      filter.ageSubgroup = DEFAULT_CHILD_SUBGROUP;
    }

    const rows = await Premium.find(filter).select(
      'insurerId tariffType tariffCode tariffName premium'
    );
    perPerson.push(new Map(rows.map((r) => [
      `${r.insurerId}|${r.tariffCode}`,
      { premium: r.premium, type: r.tariffType, name: r.tariffName, insurerId: r.insurerId, code: r.tariffCode }
    ])));
  }

  if (!perPerson.length || perPerson.some((m) => m.size === 0)) {
    return {
      year: year.year,
      redistributionYearly: year.redistributionYearly,
      offers: [],
      current: null,
      currentMatch: 'NONE'
    };
  }

  const names = new Map(
    (await PremiumInsurer.find({ year: year.year }).select('insurerId name'))
      .map((i) => [i.insurerId, i.name])
  );

  const [first, ...others] = perPerson;
  const offers: ComputedOffer[] = [];

  for (const [key, base] of first) {
    const parts = [base];
    let complete = true;
    for (const other of others) {
      const row = other.get(key);
      if (!row) { complete = false; break; }
      parts.push(row);
    }
    if (!complete) {
      continue;
    }

    const gross = round(parts.reduce((sum, p) => sum + p.premium, 0));
    const redistribution = round(monthlyRedistribution * input.insured.length);
    const total = round(gross - redistribution);

    offers.push({
      rank: 0,
      insurerId: base.insurerId,
      insurer: names.get(base.insurerId) || String(base.insurerId),
      tariffType: base.type,
      tariffCode: base.code,
      tariffName: base.name,
      monthly: { premium: gross, redistribution, total, savings: 0 },
      yearly: {
        premium: round(gross * 12),
        redistribution: round(redistribution * 12),
        total: round(total * 12),
        savings: 0
      },
      persons: parts.map((p, index) => {
        const personGross = p.premium;
        const personRedistribution = round(monthlyRedistribution);
        const personTotal = round(personGross - personRedistribution);
        return {
          ref: input.insured[index].ref,
          monthly: { premium: personGross, redistribution: personRedistribution, total: personTotal },
          yearly: {
            premium: round(personGross * 12),
            redistribution: round(personRedistribution * 12),
            total: round(personTotal * 12)
          }
        };
      })
    });
  }

  offers.sort((a, b) => a.monthly.total - b.monthly.total);
  offers.forEach((offer, index) => { offer.rank = index; });

  // Le contrat actuel sert de référence aux économies.
  //
  // À défaut de code tarifaire enregistré, la référence est le **modèle de
  // base** de la caisse actuelle, et non son offre la moins chère : prendre
  // la moins chère reviendrait à supposer que l'assuré a déjà optimisé son
  // modèle, ce qui minimiserait l'économie affichée. C'est aussi la convention
  // de priminfo lorsqu'on ne lui indique qu'une caisse.
  let current: ComputedOffer | null = null;
  let currentMatch: ComputeResult['currentMatch'] = 'NONE';

  if (input.current) {
    const sameInsurer = offers.filter((o) => o.insurerId === input.current!.insurerId);
    const wanted = input.current.tariffCode;

    if (wanted) {
      // Le code du catalogue (« KPTwindoc ») et son libellé commercial
      // (« KPTwin.doc ») désignent le même modèle : l'assuré saisit l'un ou
      // l'autre, la comparaison doit reconnaître les deux.
      current = sameInsurer.find((o) =>
        sameTariff(o.tariffCode, wanted) || (o.tariffName ? sameTariff(o.tariffName, wanted) : false)
      ) || null;
      if (current) {
        currentMatch = 'EXACT';
      }
    }

    if (!current) {
      current = sameInsurer.find((o) => o.tariffType === 'BASE')
        || sameInsurer[sameInsurer.length - 1]
        || null;
      if (current) {
        currentMatch = 'FALLBACK_BASE';
      }
    }
  }

  if (current) {
    for (const offer of offers) {
      offer.monthly.savings = round(offer.monthly.total - current.monthly.total);
      offer.yearly.savings = round(offer.yearly.total - current.yearly.total);
    }
  }

  return {
    year: year.year,
    redistributionYearly: year.redistributionYearly,
    offers,
    current,
    currentMatch
  };
}
