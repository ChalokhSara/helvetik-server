import * as cheerio from 'cheerio';

/**
 * Extraction des primes affichées par priminfo.admin.ch.
 *
 * La page de résultats n'est pas une API : c'est du HTML destiné à un
 * navigateur, sans contrat de stabilité. L'extraction s'appuie donc sur les
 * ancrages les plus solides disponibles — l'attribut `headers` de chaque
 * cellule, qui nomme sa colonne, et les classes `monthlyCell` / `yearlyCell`
 * qui nomment sa périodicité — plutôt que sur la position des colonnes, qui
 * changerait au moindre remaniement.
 *
 * Si la structure change malgré tout, le parseur renvoie zéro offre plutôt que
 * des chiffres faux : mieux vaut une erreur visible qu'une prime inventée.
 */

export type Period = 'monthly' | 'yearly';
export type Metric = 'savings' | 'prim' | 'deduct' | 'total';

export interface PremiumAmounts {
  /** Prime brute. */
  premium: number | null;
  /** Redistribution de la taxe environnementale, déduite de la prime. */
  redistribution: number | null;
  /** Prime nette effectivement payée. */
  total: number | null;
  /** Négatif = économie par rapport au contrat actuel, positif = surcoût. */
  savings: number | null;
}

export interface PersonPremium {
  /** Rang de la personne dans l'ordre des paramètres yob[i]. */
  position: number;
  monthly: PremiumAmounts;
  yearly: PremiumAmounts;
}

export interface PremiumOffer {
  /** Rang dans le classement de priminfo, du plus avantageux au moins. */
  rank: number;
  insurer: string;
  insurerUrl?: string;
  /** Nom commercial du modèle, ex. « Qualimed », « Assurance de base ». */
  model: string;
  /** Vrai pour le contrat actuel de l'assuré, marqué `prim-active` par le site. */
  current: boolean;
  monthly: PremiumAmounts;
  yearly: PremiumAmounts;
  persons: PersonPremium[];
}

export interface ParsedPremiums {
  offers: PremiumOffer[];
  /** Message d'information affiché en tête de résultats par priminfo, s'il y en a un. */
  notice?: string;
}

/** « 1'821.60 » → 1821.6 ; « (+) Surcoût » et autres libellés → null. */
function parseAmount(raw: string): number | null {
  const cleaned = raw
    .replace(/[’'’ \s]/g, '')
    .replace(/,/g, '.')
    .trim();

  const match = cleaned.match(/^[-+]?\d+(?:\.\d+)?$/);
  return match ? Number(cleaned) : null;
}

function emptyAmounts(): PremiumAmounts {
  return { premium: null, redistribution: null, total: null, savings: null };
}

const METRIC_FIELD: Record<Metric, keyof PremiumAmounts> = {
  prim: 'premium',
  deduct: 'redistribution',
  total: 'total',
  savings: 'savings'
};

/**
 * Répartit les cellules d'une ligne dans les montants mensuels et annuels.
 *
 * La périodicité vient de la classe et non de l'attribut `headers` : sur les
 * lignes par personne, priminfo référence par erreur les en-têtes mensuels
 * depuis des cellules annuelles. La classe, elle, reste juste.
 */
function readRow(
  $: cheerio.CheerioAPI,
  row: cheerio.Cheerio<never>
): { monthly: PremiumAmounts; yearly: PremiumAmounts } {
  const monthly = emptyAmounts();
  const yearly = emptyAmounts();

  row.find('td').each((_, element) => {
    const cell = $(element);
    const headers = cell.attr('headers') || '';
    const metric = headers.match(/th-\d+-(?:monthly|yearly)-(savings|prim|deduct|total)/)?.[1] as
      | Metric
      | undefined;
    if (!metric) {
      return;
    }

    const period: Period = cell.hasClass('yearlyCell') ? 'yearly' : 'monthly';
    const value = parseAmount(cell.text());
    (period === 'yearly' ? yearly : monthly)[METRIC_FIELD[metric]] = value;
  });

  return { monthly, yearly };
}

/**
 * « Caisse-maladie, Modèle: Assura , Qualimed » → assureur et modèle.
 * Le nom de l'assureur est porté par le lien vers son site, ce qui évite de
 * dépendre du libellé traduit qui le précède.
 */
function readCaption(
  $: cheerio.CheerioAPI,
  caption: cheerio.Cheerio<never>
): { insurer: string; insurerUrl?: string; model: string } {
  const link = caption.find('a').first();
  const insurer = link.text().trim();
  const insurerUrl = link.attr('href');

  const full = caption.text().replace(/\s+/g, ' ').trim();
  // Ce qui suit la dernière virgule est le nom du modèle. Le contrat courant
  // porte en plus une mention « (Votre caisse/modèle act.) », retirée ici :
  // l'information est déjà portée par le drapeau `current`.
  const model = (full.includes(',') ? full.slice(full.lastIndexOf(',') + 1) : '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    // Les césures conditionnelles du HTML n'ont pas leur place dans du JSON.
    .replace(/­/g, '')
    .trim();

  return { insurer, insurerUrl, model };
}

/**
 * Mise en page utilisée pour un assuré unique : un tableau plat, une ligne par
 * offre, sans attribut `headers`. L'ordre des cellules à l'intérieur d'une même
 * périodicité est fixé par l'en-tête : économie, prime, redistribution, total.
 */
const SINGLE_COLUMN_ORDER: (keyof PremiumAmounts)[] = [
  'savings',
  'premium',
  'redistribution',
  'total'
];

function parseSinglePersonTable($: cheerio.CheerioAPI): PremiumOffer[] {
  const table = $('table#savingsTable').first();
  if (!table.length) {
    return [];
  }

  const offers: PremiumOffer[] = [];

  table.find('tbody tr').each((index, element) => {
    const row = $(element);
    const headings = row.find('th');
    if (headings.length < 2) {
      return;
    }

    const link = headings.eq(0).find('a').first();
    const insurer = (link.text() || headings.eq(0).text()).trim();
    if (!insurer) {
      return;
    }

    const model = headings
      .eq(1)
      .text()
      .replace(/\s+/g, ' ')
      // Mention « (Votre caisse/modèle act.) » : déjà portée par `current`.
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/­/g, '')
      .trim();

    const monthly = emptyAmounts();
    const yearly = emptyAmounts();
    let monthlyIndex = 0;
    let yearlyIndex = 0;

    row.find('td').each((_, cell) => {
      const td = $(cell);
      const value = parseAmount(td.text());
      if (td.hasClass('yearlyCell')) {
        const field = SINGLE_COLUMN_ORDER[yearlyIndex++];
        if (field) yearly[field] = value;
      } else if (td.hasClass('monthlyCell')) {
        const field = SINGLE_COLUMN_ORDER[monthlyIndex++];
        if (field) monthly[field] = value;
      }
    });

    offers.push({
      rank: index,
      insurer,
      insurerUrl: link.attr('href'),
      model,
      current: row.hasClass('prim-active-row'),
      monthly,
      yearly,
      // Un seul assuré : le total du foyer est celui de la personne.
      persons: [{ position: 0, monthly, yearly }]
    });
  });

  return offers;
}

export function parsePremiums(html: string): ParsedPremiums {
  const $ = cheerio.load(html);
  const offers: PremiumOffer[] = [];

  $('li.prim-row').each((index, element) => {
    const row = $(element) as cheerio.Cheerio<never>;
    const table = row.find('table[id^="savingsTable-"]').first();
    if (!table.length) {
      return;
    }

    const { insurer, insurerUrl, model } = readCaption(
      $,
      table.find('caption').first() as cheerio.Cheerio<never>
    );
    if (!insurer) {
      return;
    }

    // Premier tbody : la ligne « Tous », total du foyer.
    const totalRow = table.find('tbody').first().find('tr').first() as cheerio.Cheerio<never>;
    const totals = readRow($, totalRow);

    // Second tbody, masqué dans la page : le détail par personne.
    const persons: PersonPremium[] = [];
    table
      .find('tbody[id^="prim-expandable-"]')
      .first()
      .find('tr')
      .each((personIndex, personElement) => {
        const amounts = readRow($, $(personElement) as cheerio.Cheerio<never>);
        persons.push({ position: personIndex, ...amounts });
      });

    offers.push({
      rank: index,
      insurer,
      insurerUrl,
      model,
      current: row.hasClass('prim-active'),
      monthly: totals.monthly,
      yearly: totals.yearly,
      persons
    });
  });

  // Aucune ligne au format multi-assurés : priminfo a servi la mise en page
  // « assuré unique », qui est structurée tout autrement.
  const allOffers = offers.length ? offers : parseSinglePersonTable($);

  const notice = $('.prim-results')
    .prevAll('p.alert')
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  return { offers: allOffers, notice: notice || undefined };
}
