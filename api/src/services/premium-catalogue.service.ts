import { Premium, PremiumInsurer, PremiumYear, TariffType } from '../models/premium.model';
import { TARIFF_TYPE_LABELS } from '../models/insurance.model';
import { activeYear, DEFAULT_REDISTRIBUTION_YEARLY } from './premium-import.service';
import { ageClassFor, resolveRegion } from './premium-query.service';

/**
 * Catalogue LAMal : les caisses et les modèles réellement proposés dans une
 * région, tels que l'OFSP les publie.
 *
 * Sert à remplacer la saisie libre par un choix. Une caisse mal orthographiée
 * ou un modèle inventé ne se voit pas au moment de la saisie : il se traduit
 * plus tard par une comparaison qui retombe silencieusement sur le modèle
 * standard et annonce une économie fausse. Choisir dans le catalogue supprime
 * la classe entière de ces erreurs.
 */

export interface CatalogueTariff {
  tariffCode: string;
  tariffName?: string;
  tariffType: TariffType;
  /** Libellé destiné à l'affichage : le modèle standard n'est pas nommé par l'OFSP. */
  label: string;
}

export interface CatalogueInsurer {
  insurerId: number;
  name: string;
  tariffs: CatalogueTariff[];
}

export interface Catalogue {
  year: number;
  location: { label: string; canton: string; region: number; plz: string };
  insurers: CatalogueInsurer[];
}

export function tariffLabel(tariff: {
  tariffName?: string;
  tariffType: TariffType;
  tariffCode: string;
}): string {
  if (tariff.tariffName) {
    return tariff.tariffName;
  }
  return tariff.tariffType === 'BASE' ? 'Assurance de base (standard)' : tariff.tariffCode;
}

/**
 * Caisses et modèles disponibles pour un NPA donné.
 * Renvoie `null` si aucune année de primes n'est en service.
 */
export async function catalogueFor(
  plz: string,
  locality?: string
): Promise<Catalogue | null> {
  const year = await activeYear();
  if (!year) {
    return null;
  }

  const region = await resolveRegion(year.year, plz, locality);
  if (!region) {
    return null;
  }

  // Un tarif existe une fois par âge, franchise et couverture accident : seule
  // sa définition nous intéresse, d'où le dédoublonnage par code.
  const rows = await Premium.find({
    year: year.year,
    canton: region.canton,
    region: region.region
  }).select('insurerId tariffCode tariffName tariffType');

  const byInsurer = new Map<number, Map<string, CatalogueTariff>>();
  for (const row of rows) {
    let tariffs = byInsurer.get(row.insurerId);
    if (!tariffs) {
      tariffs = new Map();
      byInsurer.set(row.insurerId, tariffs);
    }
    if (!tariffs.has(row.tariffCode)) {
      tariffs.set(row.tariffCode, {
        tariffCode: row.tariffCode,
        tariffName: row.tariffName,
        tariffType: row.tariffType,
        label: tariffLabel(row)
      });
    }
  }

  const names = new Map(
    (await PremiumInsurer.find({ year: year.year }).select('insurerId name'))
      .map((insurer) => [insurer.insurerId, insurer.name])
  );

  const insurers: CatalogueInsurer[] = [...byInsurer.entries()]
    .map(([insurerId, tariffs]) => ({
      insurerId,
      name: names.get(insurerId) || String(insurerId),
      tariffs: [...tariffs.values()].sort((a, b) =>
        a.tariffType.localeCompare(b.tariffType) || a.label.localeCompare(b.label))
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  return {
    year: year.year,
    location: {
      label: region.label,
      canton: region.canton,
      region: region.region,
      plz: plz.trim()
    },
    insurers
  };
}

export interface PremiumLookup {
  year: number;
  canton: string;
  region: number;
  insurerId: number;
  tariffCode: string;
  age: number;
  franchise: number;
  /** Couverture accident incluse dans la prime. */
  withAccident: boolean;
}

/**
 * Prime mensuelle officielle correspondant exactement à ces critères.
 *
 * Les enfants sont pris au sous-groupe K1, le tarif normal : K3 à K5 sont des
 * rabais de fratrie propres à chaque caisse, que l'OFSP ne suppose pas acquis.
 */
export async function premiumFor(lookup: PremiumLookup): Promise<number | null> {
  const row = await Premium.findOne({
    year: lookup.year,
    canton: lookup.canton,
    region: lookup.region,
    insurerId: lookup.insurerId,
    tariffCode: lookup.tariffCode,
    ageClass: ageClassFor(lookup.age),
    franchise: lookup.franchise,
    withAccident: lookup.withAccident,
    ...(ageClassFor(lookup.age) === 'KIN' ? { ageSubgroup: 'K1' } : {})
  }).select('premium');

  return row ? row.premium : null;
}

/**
 * Prime sous ses deux formes, celles que l'on rencontre sur les documents.
 *
 * L'OFSP publie la prime **brute**. Les caisses, elles, impriment souvent le
 * **solde** : la redistribution des taxes environnementales, identique pour
 * tout le monde, en est déjà déduite. Sur une même police on lit donc 334.05
 * et 328.90 pour le même contrat.
 *
 * Les deux sont conservées côte à côte, sans en privilégier une : c'est ce qui
 * permet de reconnaître un contrat à partir du montant imprimé, quel que soit
 * celui que la caisse a choisi d'afficher.
 */
export interface PremiumVariants {
  /** Prime publiée par l'OFSP, avant déduction. */
  gross: number;
  /** Prime après redistribution des taxes environnementales. */
  net: number;
  /** Montant mensuel de la redistribution, pour l'expliquer si besoin. */
  redistribution: number;
}

/** Redistribution mensuelle en vigueur pour une année de primes. */
async function monthlyRedistribution(year: number): Promise<number> {
  const record = await PremiumYear.findOne({ year }).select('redistributionYearly');
  return (record?.redistributionYearly ?? DEFAULT_REDISTRIBUTION_YEARLY) / 12;
}

export async function premiumVariantsFor(
  lookup: PremiumLookup
): Promise<PremiumVariants | null> {
  const gross = await premiumFor(lookup);
  if (gross === null) {
    return null;
  }

  const redistribution = await monthlyRedistribution(lookup.year);
  return {
    gross,
    net: Math.round((gross - redistribution) * 100) / 100,
    redistribution
  };
}

/**
 * Toutes les primes d'une caisse pour des critères donnés, un modèle par
 * entrée. Sert à retrouver un contrat à partir du montant lu sur sa police.
 */
export async function premiumsByTariff(
  lookup: Omit<PremiumLookup, 'tariffCode'>,
  tariffCodes: string[]
): Promise<Map<string, PremiumVariants>> {
  const redistribution = await monthlyRedistribution(lookup.year);
  const ageClass = ageClassFor(lookup.age);

  const rows = await Premium.find({
    year: lookup.year,
    canton: lookup.canton,
    region: lookup.region,
    insurerId: lookup.insurerId,
    tariffCode: { $in: tariffCodes },
    ageClass,
    franchise: lookup.franchise,
    withAccident: lookup.withAccident,
    ...(ageClass === 'KIN' ? { ageSubgroup: 'K1' } : {})
  }).select('tariffCode premium');

  return new Map(rows.map((row) => [row.tariffCode, {
    gross: row.premium,
    net: Math.round((row.premium - redistribution) * 100) / 100,
    redistribution
  }]));
}

/**
 * Adresse postale d'une caisse, prête à être imprimée sur une enveloppe.
 *
 * La raison sociale prime sur le nom court : un recommandé adressé à « CSS »
 * n'a pas de destinataire, « CSS Assurance-maladie SA » en a un. La case
 * postale, quand elle existe, remplace la rue — c'est l'adresse que la caisse
 * publie elle-même pour son courrier.
 */
export interface InsurerMailingAddress {
  name: string;
  lines: string[];
}

export async function insurerAddress(
  year: number,
  insurerId: number
): Promise<InsurerMailingAddress | null> {
  const insurer = await PremiumInsurer.findOne({ year, insurerId });
  if (!insurer) {
    return null;
  }

  const city = [insurer.plz, insurer.city].filter(Boolean).join(' ').trim();
  const lines = [insurer.poBox || insurer.street, city].filter(Boolean) as string[];

  return { name: insurer.legalName || insurer.name, lines };
}

/** Même adresse, recherchée par le nom affiché du catalogue. */
export async function insurerAddressByName(
  year: number,
  name: string
): Promise<InsurerMailingAddress | null> {
  const key = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = key(name);

  const insurers = await PremiumInsurer.find({ year });
  const match = insurers.find((i) => key(i.name) === wanted)
    || insurers.find((i) => i.legalName && key(i.legalName) === wanted)
    || insurers.find((i) => key(i.name).startsWith(wanted) && wanted.length >= 3);

  return match ? insurerAddress(year, match.insurerId) : null;
}

/** Franchises légales proposées à un assuré, selon son âge. */
export function franchisesForAge(age: number): number[] {
  return age < 19
    ? [0, 100, 200, 300, 400, 500, 600]
    : [300, 500, 1000, 1500, 2000, 2500];
}

export { TARIFF_TYPE_LABELS };
