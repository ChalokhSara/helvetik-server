import { Router, Request, Response } from 'express';
import { Client, IClient } from '../models/client.model';
import { Insurance } from '../models/insurance.model';
import { requireUser } from '../middleware/require-user';
import { fetchText, resolveInsurer, resolveLocation } from '../services/priminfo.service';
import { parsePremiums, PremiumOffer } from '../services/priminfo-premiums';
import { activeYear } from '../services/premium-import.service';
import {
  computeOffers,
  listTariffs,
  resolveInsurerByName,
  resolveRegion
} from '../services/premium-query.service';
import { TariffType } from '../models/premium.model';
import { TARIFF_TYPE_LABELS } from '../models/insurance.model';

const router = Router();

router.use(requireUser);

const PRIMINFO_BASE_URL = process.env.PRIMINFO_BASE_URL || 'https://www.priminfo.admin.ch';

const LANGUAGES = ['fr', 'de', 'it'] as const;
type Language = typeof LANGUAGES[number];

/** Modèles d'assurance : standard, médecin de famille, HMO, autres. */
const DEFAULT_MODELS = ['BASE', 'HAM', 'HMO', 'DIV'];
const ALLOWED_MODELS = new Set(DEFAULT_MODELS);
const ALLOWED_DISPLAY = new Set(['savings', 'comparison', 'change']);

/** Franchises LAMal légales, distinctes pour les adultes et les enfants. */
const ADULT_FRANCHISES = [300, 500, 1000, 1500, 2000, 2500];
const CHILD_FRANCHISES = [0, 100, 200, 300, 400, 500, 600];

/** Au-delà, l'URL devient ingérable et priminfo ne suit plus. */
const MAX_INSURED = 9;
const ADULT_FROM_AGE = 19;

const DEFAULT_OFFER_LIMIT = 20;
const MAX_OFFER_LIMIT = 500;

/**
 * Cache de la page priminfo, utilisée seulement en repli. Les primes ne
 * changent qu'une fois par an, et cela évite de faire porter à un service
 * public le coût d'un mégaoctet à chaque consultation.
 */
const PREMIUM_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const PREMIUM_CACHE_MAX_ENTRIES = 200;
const premiumCache = new Map<string, { html: string; fetchedAt: number }>();

function readCachedPage(url: string): { html: string; fetchedAt: number } | undefined {
  const entry = premiumCache.get(url);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.fetchedAt > PREMIUM_CACHE_TTL_MS) {
    premiumCache.delete(url);
    return undefined;
  }
  return entry;
}

function cachePage(url: string, html: string): void {
  if (premiumCache.size >= PREMIUM_CACHE_MAX_ENTRIES) {
    const oldest = premiumCache.keys().next().value;
    if (oldest) {
      premiumCache.delete(oldest);
    }
  }
  premiumCache.set(url, { html, fetchedAt: Date.now() });
}

export interface QueryFailure {
  status: number;
  code: string;
  message: string;
}

function fail(status: number, code: string, message: string): QueryFailure {
  return { status, code, message };
}

function isQueryFailure(value: unknown): value is QueryFailure {
  return Boolean(value && typeof value === 'object' && 'code' in value && 'status' in value);
}

function ageAt(birthdate: Date, reference: Date): number {
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
function nearestLegalFranchise(value: number | undefined, isChild: boolean): number {
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

interface InsuredSummary {
  clientUid: string;
  name: string;
  yob: number;
  age: number;
  franchise: number;
  franchiseSource: string;
  employerAccidentCoverage: boolean;
  coverage: number;
  coverageSource: string;
}

interface HouseholdContext {
  lang: Language;
  display: string;
  models: string[];
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

/**
 * Traduit le foyer et les paramètres de la requête en critères de comparaison.
 *
 * Partagé par les trois chemins — lien priminfo, optimisation depuis la base,
 * optimisation par interrogation du site — pour que les règles de franchise et
 * de couverture accident ne puissent pas diverger de l'un à l'autre.
 */
async function buildHouseholdContext(req: Request): Promise<HouseholdContext> {
  const user = req.authUser!;
  const warnings: string[] = [];

  const lang = String(req.query.lang || 'fr').toLowerCase() as Language;
  if (!LANGUAGES.includes(lang)) {
    throw fail(400, 'INVALID_LANG', `Langue inconnue. Valeurs acceptées : ${LANGUAGES.join(', ')}.`);
  }

  const display = String(req.query.display || 'savings');
  if (!ALLOWED_DISPLAY.has(display)) {
    throw fail(400, 'INVALID_DISPLAY',
      `Affichage inconnu. Valeurs acceptées : ${[...ALLOWED_DISPLAY].join(', ')}.`);
  }

  // Sans paramètre, la couverture accident est déduite de chaque contrat LAMal.
  // Fourni, il force la même valeur pour tout le monde.
  const coverageOverride = req.query.coverage === undefined ? undefined : String(req.query.coverage);
  if (coverageOverride !== undefined && coverageOverride !== '0' && coverageOverride !== '1') {
    throw fail(400, 'INVALID_COVERAGE', 'La couverture accident doit valoir 0 ou 1.');
  }

  const models = String(req.query.models || DEFAULT_MODELS.join(','))
    .split(',')
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
  const unknownModels = models.filter((m) => !ALLOWED_MODELS.has(m));
  if (unknownModels.length) {
    throw fail(400, 'INVALID_MODEL',
      `Modèle inconnu : ${unknownModels.join(', ')}. Valeurs acceptées : ${DEFAULT_MODELS.join(', ')}.`);
  }

  const requested = (Array.isArray(req.query.clientUid) ? req.query.clientUid : [req.query.clientUid])
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  const filter: Record<string, unknown> = { userUid: user.uid };
  if (requested.length) {
    filter.uid = { $in: requested };
  }

  const clients: IClient[] = await Client.find(filter).sort({ birthdate: 1 });
  if (!clients.length) {
    throw fail(404, 'NO_INSURED', requested.length
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

  const lamal = await Insurance.find({
    userUid: user.uid,
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
    const coverage = coverageOverride ?? (coveredByEmployer ? '0' : '1');

    return {
      clientUid: client.uid,
      name: `${client.firstname} ${client.name}`,
      yob: client.birthdate.getUTCFullYear(),
      age,
      franchise,
      franchiseSource: contract ? 'contrat' : 'défaut',
      employerAccidentCoverage: coveredByEmployer,
      coverage: Number(coverage),
      coverageSource: coverageOverride !== undefined
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
    lang,
    display,
    models,
    reference,
    selected,
    insured,
    currentProvider: contract?.provider,
    currentTariffCode: contract?.tariffCode,
    currentProviderHolder: holder,
    warnings
  };
}

interface PriminfoQuery {
  url: string;
  display: string;
  location: { id: string; label: string; plz: string } | null;
  insurer: { id: string; name: string } | null;
  insured: InsuredSummary[];
  warnings: string[];
}

/** Construit l'URL priminfo préremplie à partir du contexte du foyer. */
async function buildPriminfoQuery(
  req: Request,
  options: { display?: string } = {}
): Promise<PriminfoQuery> {
  const context = await buildHouseholdContext(req);
  const warnings = [...context.warnings];
  const params = new URLSearchParams();

  const location = await resolveLocation(context.reference.plz, context.reference.location);
  if (location.warning) {
    warnings.push(location.warning);
  }
  if (location.match) {
    params.set('location_id', location.match.id);
  }

  context.insured.forEach((person, position) => {
    params.set(`yob[${position}]`, String(person.yob));
    params.set(`franchise[${position}]`, String(person.franchise));
    params.set(`coverage[${position}]`, String(person.coverage));
  });

  let insurer: { id: string; name: string } | null = null;
  if (context.currentProvider && location.match) {
    const resolved = await resolveInsurer(context.currentProvider, location.match.id);
    if (resolved.warning) {
      warnings.push(resolved.warning);
    }
    if (resolved.match) {
      insurer = resolved.match;
      params.set('insurer', resolved.match.id);
    }
  }

  params.set('plan', 'BASE');
  for (const model of context.models) {
    params.append('models[]', model);
  }

  // L'affichage « économies » se calcule par rapport à la caisse actuelle :
  // sans elle, priminfo refuse la requête (HTTP 400).
  const wanted = options.display ?? context.display;
  let effectiveDisplay = wanted;
  if (wanted === 'savings' && !insurer) {
    effectiveDisplay = 'comparison';
    warnings.push(
      'Aucune caisse actuelle reconnue : le comparateur affichera les primes sans calcul d\'économie.'
    );
  }
  params.set('display', effectiveDisplay);

  return {
    url: `${PRIMINFO_BASE_URL}/${context.lang}/praemien?${params.toString()}`,
    display: effectiveDisplay,
    location: location.match
      ? { id: location.match.id, label: location.match.label, plz: context.reference.plz }
      : null,
    insurer,
    insured: context.insured,
    warnings
  };
}

/**
 * @swagger
 * /api/comparison/priminfo:
 *   get:
 *     summary: Lien vers le comparateur officiel priminfo, prérempli
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: clientUid
 *         schema: { type: string }
 *       - in: query
 *         name: lang
 *         schema: { type: string, enum: [fr, de, it], default: fr }
 *       - in: query
 *         name: coverage
 *         schema: { type: integer, enum: [0, 1] }
 *       - in: query
 *         name: display
 *         schema: { type: string, enum: [savings, comparison, change], default: savings }
 *       - in: query
 *         name: models
 *         schema: { type: string, default: "BASE,HAM,HMO,DIV" }
 *       - in: query
 *         name: redirect
 *         schema: { type: boolean, default: false }
 *     responses:
 *       200: { description: Lien construit }
 *       302: { description: Redirection vers priminfo }
 *       400: { description: Paramètre invalide }
 *       404: { description: Aucun assuré dans ce foyer }
 */
router.get('/priminfo', async (req: Request, res: Response) => {
  try {
    const built = await buildPriminfoQuery(req);
    if (String(req.query.redirect || '') === 'true') {
      return res.redirect(built.url);
    }
    res.json(built);
  } catch (err) {
    if (isQueryFailure(err)) {
      return res.status(err.status).json({ code: err.code, message: err.message });
    }
    console.error('Erreur de construction du lien priminfo:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

function readLimit(req: Request): number {
  return Math.min(
    MAX_OFFER_LIMIT,
    Math.max(1, Number.parseInt(String(req.query.limit ?? DEFAULT_OFFER_LIMIT), 10) || DEFAULT_OFFER_LIMIT)
  );
}

/**
 * Optimisation à partir des données officielles importées.
 * Renvoie `null` si aucune année n'est en service, pour laisser la main au repli.
 */
async function optimiseFromDatabase(req: Request): Promise<Record<string, unknown> | null> {
  const year = await activeYear();
  if (!year) {
    return null;
  }

  const context = await buildHouseholdContext(req);
  const warnings = [...context.warnings];

  const region = await resolveRegion(year.year, context.reference.plz, context.reference.location);
  if (!region) {
    throw fail(400, 'LOCATION_REQUIRED',
      `Le NPA ${context.reference.plz} est introuvable dans les régions de primes ${year.year}.`);
  }
  if (region.ambiguous) {
    warnings.push(
      `Le NPA ${context.reference.plz} couvre plusieurs régions de primes ; « ${region.label} » a été retenue.`
    );
  }

  if (!context.currentProvider) {
    throw fail(400, 'CURRENT_LAMAL_REQUIRED',
      'L\'optimisation compare vos primes à votre contrat actuel : renseignez une assurance LAMal en vigueur.');
  }

  const insurer = await resolveInsurerByName(year.year, context.currentProvider);
  if (!insurer) {
    warnings.push(
      `La caisse « ${context.currentProvider} » n'a pas été reconnue parmi les assureurs LAMal : ` +
      'les économies ne peuvent pas être calculées par rapport à votre contrat.'
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
    tariffTypes: context.models as TariffType[],
    current: insurer
      ? { insurerId: insurer.insurerId, tariffCode: context.currentTariffCode }
      : undefined
  });

  if (insurer && !context.currentTariffCode) {
    warnings.push(
      'Le modèle de votre contrat n\'est pas enregistré : la comparaison prend le modèle ' +
      'standard comme référence. Renseignez-le pour une économie exacte.'
    );
  }

  if (!computed || !computed.offers.length) {
    throw fail(404, 'NO_PREMIUM_DATA',
      `Aucune prime ${year.year} ne correspond à ce foyer dans les données officielles.`);
  }

  const limit = readLimit(req);
  const includePersons = String(req.query.persons ?? 'true') !== 'false';
  const names = new Map(context.insured.map((person) => [person.clientUid, person.name]));

  // Le dictionnaire de l'OFSP ne nomme que les modèles alternatifs : le modèle
  // standard n'y figure pas, il reçoit donc son libellé usuel.
  const modelLabel = (offer: (typeof computed.offers)[number]) =>
    offer.tariffName || (offer.tariffType === 'BASE' ? 'Assurance de base' : offer.tariffCode);

  const shape = (offer: (typeof computed.offers)[number]) => ({
    rank: offer.rank,
    insurerId: offer.insurerId,
    insurer: offer.insurer,
    model: modelLabel(offer),
    tariffType: offer.tariffType,
    tariffCode: offer.tariffCode,
    current: computed.current?.insurerId === offer.insurerId &&
      computed.current?.tariffCode === offer.tariffCode,
    monthly: offer.monthly,
    yearly: offer.yearly,
    persons: includePersons
      ? offer.persons.map((person) => ({
          clientUid: person.ref,
          name: names.get(person.ref) ?? null,
          monthly: person.monthly,
          yearly: person.yearly
        }))
      : undefined
  });

  const best = computed.offers[0];
  const savings = computed.current
    ? {
        monthly: Math.max(0, Math.round((computed.current.monthly.total - best.monthly.total) * 100) / 100),
        yearly: Math.max(0, Math.round((computed.current.yearly.total - best.yearly.total) * 100) / 100)
      }
    : { monthly: 0, yearly: 0 };

  return {
    source: {
      provider: 'OFSP — données officielles',
      year: computed.year,
      redistributionYearly: computed.redistributionYearly,
      redistributionMonthly: Math.round((computed.redistributionYearly / 12) * 100) / 100,
      activatedAt: year.activatedAt
    },
    location: {
      label: region.label,
      canton: region.canton,
      region: region.region,
      plz: context.reference.plz
    },
    currentInsurer: insurer,
    insured: context.insured,
    totalOffers: computed.offers.length,
    current: computed.current ? shape(computed.current) : null,
    best: shape(best),
    potentialSavings: savings,
    offers: computed.offers.slice(0, limit).map(shape),
    warnings
  };
}

/** Économie d'une offre priminfo, exprimée en montant positif. */
function savingsOf(offer: PremiumOffer | undefined) {
  if (!offer) {
    return { monthly: 0, yearly: 0 };
  }
  return {
    monthly: offer.monthly.savings !== null ? Math.max(0, -offer.monthly.savings) : 0,
    yearly: offer.yearly.savings !== null ? Math.max(0, -offer.yearly.savings) : 0
  };
}

function withClientNames(offer: PremiumOffer, insured: InsuredSummary[]) {
  return {
    ...offer,
    persons: offer.persons.map((person) => ({
      ...person,
      clientUid: insured[person.position]?.clientUid ?? null,
      name: insured[person.position]?.name ?? null
    }))
  };
}

/**
 * Repli : interrogation directe du comparateur, tant qu'aucune année de primes
 * n'est en service dans la console d'administration.
 */
async function optimiseFromPriminfo(req: Request, res: Response) {
  const limit = readLimit(req);
  const includePersons = String(req.query.persons ?? 'true') !== 'false';
  const refresh = String(req.query.refresh || '') === 'true';

  const built = await buildPriminfoQuery(req, { display: 'savings' });
  const { url, location, insurer, insured, warnings } = built;

  if (!location) {
    return res.status(400).json({
      code: 'LOCATION_REQUIRED',
      message: 'La localité du foyer n\'a pas pu être résolue : la comparaison des primes est impossible.',
      warnings
    });
  }

  if (!insurer) {
    return res.status(400).json({
      code: 'CURRENT_LAMAL_REQUIRED',
      message: 'L\'optimisation compare vos primes à votre contrat actuel : renseignez une assurance ' +
        'LAMal en vigueur, avec un prestataire reconnu par le comparateur officiel.',
      missingFor: insured.filter((p) => p.franchiseSource !== 'contrat').map((p) => p.name),
      warnings
    });
  }

  let page = refresh ? undefined : readCachedPage(url);
  const cached = Boolean(page);

  if (!page) {
    let html: string;
    try {
      html = await fetchText(url);
    } catch (err) {
      console.error('[priminfo] page de primes injoignable:', (err as Error).message);
      return res.status(502).json({
        code: 'PRIMINFO_UNAVAILABLE',
        message: 'Le comparateur officiel est momentanément injoignable. Réessayez plus tard.',
        url
      });
    }
    page = { html, fetchedAt: Date.now() };
    cachePage(url, html);
  }

  const parsed = parsePremiums(page.html);
  if (!parsed.offers.length) {
    console.error('[priminfo] aucune offre extraite — la structure de la page a probablement changé.');
    return res.status(502).json({
      code: 'PRIMINFO_PARSE_FAILED',
      message: 'Les primes n\'ont pas pu être lues sur le comparateur officiel. ' +
        'Sa présentation a probablement changé.',
      url
    });
  }

  const current = parsed.offers.find((offer) => offer.current);
  const best = parsed.offers[0];
  const shape = (offer: PremiumOffer) =>
    includePersons ? withClientNames(offer, insured) : { ...offer, persons: undefined };

  res.json({
    source: { provider: 'priminfo.admin.ch', url, fetchedAt: new Date(page.fetchedAt).toISOString(), cached },
    location,
    currentInsurer: insurer,
    insured,
    notice: parsed.notice,
    totalOffers: parsed.offers.length,
    current: current ? shape(current) : null,
    best: shape(best),
    potentialSavings: savingsOf(best),
    offers: parsed.offers.slice(0, limit).map(shape),
    warnings: [
      ...warnings,
      'Primes lues sur le site de l\'OFSP : importez les données officielles depuis la console ' +
      'd\'administration pour un calcul local.'
    ]
  });
}

/**
 * @swagger
 * /api/comparison/lamal-models:
 *   get:
 *     summary: Modèles LAMal proposés par une caisse
 *     description: >
 *       Liste les modèles du catalogue officiel pour un prestataire donné,
 *       dans la région du foyer. Permet à l'application de faire choisir son
 *       modèle à l'assuré, et donc de renseigner `tariffCode` sur son contrat.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: provider
 *         schema: { type: string }
 *         description: Nom de la caisse. À défaut, celle du contrat LAMal en vigueur.
 *       - in: query
 *         name: clientUid
 *         schema: { type: string }
 *         description: Assuré dont la région sert de cadre
 *     responses:
 *       200: { description: Modèles disponibles }
 *       400: { description: Caisse non précisée ou non reconnue }
 *       404: { description: Aucune donnée de primes en service }
 */
router.get('/lamal-models', async (req: Request, res: Response) => {
  try {
    const year = await activeYear();
    if (!year) {
      throw fail(404, 'NO_PREMIUM_DATA',
        'Aucune donnée de primes en service : importez-les depuis la console d\'administration.');
    }

    const context = await buildHouseholdContext(req);
    const provider = String(req.query.provider || '').trim() || context.currentProvider;
    if (!provider) {
      throw fail(400, 'PROVIDER_REQUIRED',
        'Précisez une caisse, ou renseignez d\'abord un contrat LAMal en vigueur.');
    }

    const insurer = await resolveInsurerByName(year.year, provider);
    if (!insurer) {
      throw fail(400, 'INSURER_NOT_FOUND',
        `La caisse « ${provider} » ne figure pas parmi les assureurs LAMal reconnus.`);
    }

    const region = await resolveRegion(year.year, context.reference.plz, context.reference.location);
    const tariffs = await listTariffs(year.year, insurer.insurerId,
      region ? { canton: region.canton, region: region.region } : undefined);

    res.json({
      year: year.year,
      insurer,
      location: region ? { label: region.label, canton: region.canton, region: region.region } : null,
      // Le modèle standard n'a pas de nom au catalogue de l'OFSP.
      models: tariffs.map((t) => ({
        ...t,
        label: t.tariffName || (t.tariffType === 'BASE' ? 'Assurance de base' : t.tariffCode),
        typeLabel: TARIFF_TYPE_LABELS[t.tariffType]
      }))
    });
  } catch (err) {
    if (isQueryFailure(err)) {
      return res.status(err.status).json({ code: err.code, message: err.message });
    }
    console.error('Erreur de listing des modèles LAMal:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

/**
 * @swagger
 * /api/comparison/lamal-optimisation:
 *   get:
 *     summary: Optimisation LAMal — primes comparées, en JSON
 *     description: >
 *       Compare les primes du foyer à partir des données officielles de l'OFSP
 *       importées dans la base. Tant qu'aucune année n'est en service, la route
 *       interroge directement priminfo.admin.ch.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: clientUid
 *         schema: { type: string }
 *       - in: query
 *         name: coverage
 *         schema: { type: integer, enum: [0, 1] }
 *       - in: query
 *         name: models
 *         schema: { type: string, default: "BASE,HAM,HMO,DIV" }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 500 }
 *       - in: query
 *         name: persons
 *         schema: { type: boolean, default: true }
 *     responses:
 *       200: { description: Primes comparées }
 *       400: { description: Paramètre invalide ou contrat LAMal manquant }
 *       404: { description: Aucun assuré, ou aucune prime correspondante }
 *       502: { description: Repli priminfo indisponible }
 */
router.get('/lamal-optimisation', async (req: Request, res: Response) => {
  try {
    // Les données officielles importées priment sur l'interrogation du site.
    const fromDatabase = await optimiseFromDatabase(req);
    if (fromDatabase) {
      return res.json(fromDatabase);
    }
    return await optimiseFromPriminfo(req, res);
  } catch (err) {
    if (isQueryFailure(err)) {
      return res.status(err.status).json({ code: err.code, message: err.message });
    }
    console.error('Erreur d\'optimisation LAMal:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

export { router as comparisonRouter };
