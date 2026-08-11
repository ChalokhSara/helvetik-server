import { Router, Request, Response } from 'express';
import { requireUser } from '../middleware/require-user';
import { fetchText, resolveInsurer, resolveLocation } from '../services/priminfo.service';
import { parsePremiums, PremiumOffer } from '../services/priminfo-premiums';
import { activeYear } from '../services/premium-import.service';
import { listTariffs, resolveInsurerByName, resolveRegion } from '../services/premium-query.service';
import { catalogueFor, premiumFor } from '../services/premium-catalogue.service';
import {
  buildHouseholdContext,
  HouseholdContext,
  InsuredSummary,
  MAX_INSURED
} from '../services/household.service';
import {
  IndividualPlan,
  modelLabel,
  optimiseLamal,
  OptimisationResult
} from '../services/lamal-optimisation.service';
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

/** Contexte du foyer, enrichi des paramètres propres à la requête HTTP. */
interface QueryContext extends HouseholdContext {
  lang: Language;
  display: string;
  models: string[];
}

/**
 * Traduit le foyer et les paramètres de la requête en critères de comparaison.
 *
 * Partagé par les trois chemins — lien priminfo, optimisation depuis la base,
 * optimisation par interrogation du site. Seule la lecture des paramètres HTTP
 * vit ici : la composition du foyer elle-même (franchises légales, inversion de
 * la couverture accident, choix du contrat de référence) appartient au service
 * partagé avec le site web, pour que les deux canaux ne puissent pas diverger.
 */
async function buildQueryContext(req: Request): Promise<QueryContext> {
  const user = req.authUser!;

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

  const clientUids = (Array.isArray(req.query.clientUid) ? req.query.clientUid : [req.query.clientUid])
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  // `HouseholdError` porte déjà `status` et `code` : il traverse `isQueryFailure`
  // sans traduction et ressort avec le même contrat JSON qu'auparavant.
  const context = await buildHouseholdContext(user.uid, { clientUids, coverageOverride });

  return { ...context, lang, display, models };
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
  const context = await buildQueryContext(req);
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
  const context = await buildQueryContext(req);
  const result = await optimiseLamal(context, { models: context.models });
  if (!result) {
    return null;
  }

  const limit = readLimit(req);
  const includePersons = String(req.query.persons ?? 'true') !== 'false';
  const names = new Map(result.insured.map((person) => [person.clientUid, person.name]));

  const shape = (offer: OptimisationResult['offers'][number]) => ({
    rank: offer.rank,
    insurerId: offer.insurerId,
    insurer: offer.insurer,
    model: modelLabel(offer),
    tariffType: offer.tariffType,
    tariffCode: offer.tariffCode,
    current: result.current?.insurerId === offer.insurerId &&
      result.current?.tariffCode === offer.tariffCode,
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

  /**
   * Répartition individuelle : chaque assuré chez la caisse la moins chère pour
   * lui. Le classement principal impose une seule caisse à tout le foyer, ce qui
   * ne peut qu'écarter des possibilités — cette variante est donc toujours
   * inférieure ou égale, et rien ne s'y oppose en LAMal où les primes sont
   * réglementées par personne. `null` pour un assuré seul, où les deux se confondent.
   */
  const shapePlan = (plan: IndividualPlan) => ({
    clientUid: plan.ref,
    name: plan.name,
    best: shape(plan.best),
    current: plan.current ? shape(plan.current) : null,
    savings: plan.savings
  });

  return {
    source: {
      provider: 'OFSP — données officielles',
      year: result.year,
      redistributionYearly: result.redistributionYearly,
      redistributionMonthly: Math.round((result.redistributionYearly / 12) * 100) / 100,
      activatedAt: result.activatedAt
    },
    location: result.location,
    currentInsurer: result.insurer,
    insured: result.insured,
    totalOffers: result.offers.length,
    current: result.current ? shape(result.current) : null,
    best: shape(result.offers[0]),
    potentialSavings: result.potentialSavings,
    offers: result.offers.slice(0, limit).map(shape),
    individual: result.individual
      ? {
          plans: result.individual.plans.map(shapePlan),
          monthly: result.individual.monthly,
          yearly: result.individual.yearly,
          savings: result.individual.savings,
          extraSavings: result.individual.extra,
          insurerCount: result.individual.insurerCount
        }
      : null,
    warnings: result.warnings
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

    const context = await buildQueryContext(req);
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
 * /api/comparison/lamal-catalogue:
 *   get:
 *     summary: Caisses et modèles LAMal proposés dans la région du foyer
 *     description: >
 *       Alimente les listes de choix des formulaires de saisie : plutôt que de
 *       laisser l'assuré écrire le nom de sa caisse et de son modèle, il les
 *       choisit parmi ceux que l'OFSP publie réellement pour sa région.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: clientUid
 *         schema: { type: string }
 *         description: Assuré dont la région sert de cadre. À défaut, le premier du foyer.
 *     responses:
 *       200: { description: Catalogue de la région }
 *       404: { description: Aucune donnée de primes, ou NPA hors des régions connues }
 */
router.get('/lamal-catalogue', async (req: Request, res: Response) => {
  try {
    const context = await buildQueryContext(req);
    const catalogue = await catalogueFor(context.reference.plz, context.reference.location);

    if (!catalogue) {
      throw fail(404, 'NO_PREMIUM_DATA',
        `Aucun tarif disponible pour le NPA ${context.reference.plz} : les données officielles ` +
        'ne sont pas en service, ou ce NPA ne figure pas dans les régions de primes.');
    }

    res.json({
      year: catalogue.year,
      location: catalogue.location,
      insurers: catalogue.insurers.map((insurer) => ({
        ...insurer,
        tariffs: insurer.tariffs.map((tariff) => ({
          ...tariff,
          typeLabel: TARIFF_TYPE_LABELS[tariff.tariffType]
        }))
      }))
    });
  } catch (err) {
    if (isQueryFailure(err)) {
      return res.status(err.status).json({ code: err.code, message: err.message });
    }
    console.error('Erreur de listing du catalogue LAMal:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

/**
 * @swagger
 * /api/comparison/lamal-premium:
 *   get:
 *     summary: Prime officielle d'un modèle pour un assuré précis
 *     description: >
 *       Renvoie le montant exact publié par l'OFSP, pour éviter que l'assuré
 *       ait à recopier sa prime depuis sa police. Les critères manquants sont
 *       repris de l'assuré et de son contrat LAMal en vigueur.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: insurerId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: tariffCode
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: clientUid
 *         schema: { type: string }
 *       - in: query
 *         name: franchise
 *         schema: { type: integer }
 *       - in: query
 *         name: coverage
 *         schema: { type: string, enum: ['0', '1'] }
 *         description: 1 si la couverture accident est incluse dans la prime.
 *     responses:
 *       200: { description: Prime trouvée }
 *       400: { description: Critère manquant ou invalide }
 *       404: { description: Aucune prime ne correspond à ces critères }
 */
router.get('/lamal-premium', async (req: Request, res: Response) => {
  try {
    const context = await buildQueryContext(req);
    const person = context.insured[0];

    const insurerId = Number.parseInt(String(req.query.insurerId ?? ''), 10);
    const tariffCode = String(req.query.tariffCode || '').trim();
    if (!Number.isFinite(insurerId) || !tariffCode) {
      throw fail(400, 'MODEL_REQUIRED', 'Précisez la caisse (insurerId) et le modèle (tariffCode).');
    }

    const catalogue = await catalogueFor(context.reference.plz, context.reference.location);
    if (!catalogue) {
      throw fail(404, 'NO_PREMIUM_DATA',
        `Aucun tarif disponible pour le NPA ${context.reference.plz}.`);
    }

    // Les critères non fournis viennent de l'assuré : c'est ce qui permet à
    // l'appelant de ne transmettre que la caisse et le modèle.
    const franchise = req.query.franchise === undefined
      ? person.franchise
      : Number.parseInt(String(req.query.franchise), 10);
    if (!Number.isFinite(franchise)) {
      throw fail(400, 'INVALID_FRANCHISE', 'La franchise doit être un nombre.');
    }

    const premium = await premiumFor({
      year: catalogue.year,
      canton: catalogue.location.canton,
      region: catalogue.location.region,
      insurerId,
      tariffCode,
      age: person.age,
      franchise,
      withAccident: person.coverage === 1
    });

    if (premium === null) {
      throw fail(404, 'NO_PREMIUM_FOR_CRITERIA',
        'Aucune prime officielle ne correspond à ces critères : ce modèle n\'est probablement ' +
        'pas proposé pour cette franchise ou cette tranche d\'âge.');
    }

    const insurer = catalogue.insurers.find((i) => i.insurerId === insurerId);
    const tariff = insurer?.tariffs.find((t) => t.tariffCode === tariffCode);

    res.json({
      year: catalogue.year,
      location: catalogue.location,
      insurer: insurer ? { insurerId: insurer.insurerId, name: insurer.name } : null,
      model: tariff ? { ...tariff, typeLabel: TARIFF_TYPE_LABELS[tariff.tariffType] } : null,
      insured: {
        clientUid: person.clientUid,
        name: person.name,
        age: person.age,
        franchise,
        withAccident: person.coverage === 1
      },
      monthly: premium,
      yearly: Math.round(premium * 12 * 100) / 100
    });
  } catch (err) {
    if (isQueryFailure(err)) {
      return res.status(err.status).json({ code: err.code, message: err.message });
    }
    console.error('Erreur de lecture d\'une prime LAMal:', err);
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
