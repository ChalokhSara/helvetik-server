import { Router, Request, Response } from 'express';
import { requireUser } from '../middleware/require-user';
import { Client } from '../models/client.model';
import { Insurance, TARIFF_TYPE_LABELS } from '../models/insurance.model';
import { PremiumInsurer, TariffType } from '../models/premium.model';
import { activeYear } from '../services/premium-import.service';
import { computeOffers, resolveInsurerByName, resolveRegion } from '../services/premium-query.service';
import { insurerAddress } from '../services/premium-catalogue.service';
import { buildHouseholdContext, HouseholdError } from '../services/household.service';
import { modelLabel } from '../services/lamal-optimisation.service';
import { retrieveDocument } from '../services/document-vault.service';
import {
  cancellationDeadlineFor,
  LetterKind,
  letterFilename,
  renderLetter,
  targetYear
} from '../services/letter.service';
import { onlineChannelFor } from '../config/insurer-channels';

/**
 * Assurance de base pour l'application mobile : la liste des caisses et de
 * leurs primes, et les moyens de s'y affilier.
 *
 * Le service est gratuit et ne conseille pas. La liste reproduit les primes
 * officielles de l'OFSP — celles que priminfo.ch publie — triées par montant,
 * sans offre mise en avant ni « meilleur choix » : l'assuré choisit, l'outil
 * lui évite seulement de recopier ses données et de chercher une adresse.
 */

const router = Router();

router.use(requireUser);

const MODELS = ['BASE', 'HAM', 'HMO', 'DIV'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

type Failure = { status: number; code: string; message: string };

function fail(status: number, code: string, message: string): Failure {
  return { status, code, message };
}

function isFailure(value: unknown): value is Failure {
  return Boolean(value && typeof value === 'object' && 'code' in value && 'status' in value);
}

function sendError(res: Response, err: unknown, context: string) {
  if (err instanceof HouseholdError || isFailure(err)) {
    return res.status(err.status).json({ code: err.code, message: err.message });
  }
  console.error(`Erreur ${context}:`, err);
  res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
}

/** Le site publié par l'OFSP s'écrit souvent sans protocole : « www.css.ch ». */
function absoluteUrl(website?: string): string | undefined {
  const value = (website || '').trim();
  if (!value) {
    return undefined;
  }
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export type SubscriptionChannel = 'ONLINE' | 'EMAIL' | 'POST';

/**
 * Moyens de s'affilier à une caisse, du plus direct au plus universel.
 *
 * En ligne quand la caisse le permet ; sinon la lettre d'affiliation, à
 * envoyer par email si la caisse publie une adresse, et toujours par la poste.
 * La lettre reste proposée même quand la souscription en ligne existe : c'est
 * le seul canal qui fonctionne à coup sûr.
 */
async function subscriptionFor(year: number, insurerId: number) {
  const insurer = await PremiumInsurer.findOne({ year, insurerId });
  if (!insurer) {
    return null;
  }

  const online = onlineChannelFor(insurer.name, insurer.legalName);
  const website = absoluteUrl(insurer.website);
  const address = await insurerAddress(year, insurerId);
  const channels: SubscriptionChannel[] = [];
  if (online) { channels.push('ONLINE'); }
  if (insurer.email) { channels.push('EMAIL'); }
  channels.push('POST');

  return {
    insurerId,
    name: insurer.name,
    legalName: insurer.legalName,
    primary: channels[0],
    channels,
    onlineUrl: online ? (online.url || website) : undefined,
    website,
    email: insurer.email || undefined,
    phone: insurer.phone || undefined,
    postalAddress: address ? { name: address.name, lines: address.lines } : null
  };
}

/** Franchise demandée, à appliquer aux assurés retenus. */
function readFranchise(req: Request): number | undefined {
  if (req.query.franchise === undefined || req.query.franchise === '') {
    return undefined;
  }
  const value = Number.parseInt(String(req.query.franchise), 10);
  if (!Number.isFinite(value)) {
    throw fail(400, 'INVALID_FRANCHISE', 'La franchise doit être un nombre.');
  }
  return value;
}

function readClientUids(req: Request): string[] {
  return (Array.isArray(req.query.clientUid) ? req.query.clientUid : [req.query.clientUid])
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * @swagger
 * /api/lamal/offers:
 *   get:
 *     summary: Primes LAMal officielles pour le foyer, toutes caisses confondues
 *     description: >
 *       Liste neutre des offres de la région du foyer, telles que l'OFSP les
 *       publie (source de priminfo.ch), triées par prime. Contrairement à
 *       /api/comparison/lamal-optimisation, aucun contrat actuel n'est exigé ;
 *       s'il existe, il est seulement signalé dans la liste. Chaque offre
 *       indique comment s'affilier : en ligne, par email ou par la poste.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: clientUid
 *         schema: { type: string }
 *         description: Assurés à chiffrer, séparés par des virgules. À défaut, tout le foyer.
 *       - in: query
 *         name: franchise
 *         schema: { type: integer }
 *         description: Franchise à appliquer à chaque assuré, ramenée à la valeur légale la plus proche.
 *       - in: query
 *         name: coverage
 *         schema: { type: string, enum: ['0', '1'] }
 *       - in: query
 *         name: models
 *         schema: { type: string, default: "BASE,HAM,HMO,DIV" }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Filtre sur le nom de la caisse ou du modèle
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100, maximum: 500 }
 *     responses:
 *       200: { description: Offres }
 *       400: { description: Paramètre invalide ou date de naissance manquante }
 *       404: { description: Aucune donnée de primes en service }
 */
router.get('/offers', async (req: Request, res: Response) => {
  try {
    const user = req.authUser!;
    const year = await activeYear();
    if (!year) {
      throw fail(404, 'NO_PREMIUM_DATA',
        'Les primes officielles ne sont pas encore en service : elles doivent être ' +
        'importées depuis la console d\'administration.');
    }

    const coverage = req.query.coverage === undefined ? undefined : String(req.query.coverage);
    if (coverage !== undefined && coverage !== '0' && coverage !== '1') {
      throw fail(400, 'INVALID_COVERAGE', 'La couverture accident doit valoir 0 ou 1.');
    }

    const models = String(req.query.models || MODELS.join(','))
      .split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);
    const unknown = models.filter((m) => !MODELS.includes(m));
    if (unknown.length) {
      throw fail(400, 'INVALID_MODEL',
        `Modèle inconnu : ${unknown.join(', ')}. Valeurs acceptées : ${MODELS.join(', ')}.`);
    }

    const clientUids = readClientUids(req);
    const franchise = readFranchise(req);
    const franchiseOverrides = franchise === undefined
      ? undefined
      : Object.fromEntries((await Client.find({
          userUid: user.uid,
          ...(clientUids.length ? { uid: { $in: clientUids } } : {})
        }).select('uid')).map((c) => [c.uid, franchise]));

    const context = await buildHouseholdContext(user.uid, {
      clientUids,
      coverageOverride: coverage,
      franchiseOverrides
    });

    const region = await resolveRegion(year.year, context.reference.plz, context.reference.location);
    if (!region) {
      throw fail(400, 'LOCATION_REQUIRED',
        `Le NPA ${context.reference.plz} est introuvable dans les régions de primes ${year.year}.`);
    }

    const current = context.currentProvider
      ? await resolveInsurerByName(year.year, context.currentProvider)
      : null;

    const computed = await computeOffers({
      canton: region.canton,
      region: region.region,
      insured: context.insured.map((person) => ({
        ref: person.clientUid,
        age: person.age,
        franchise: person.franchise,
        withAccident: person.coverage === 1
      })),
      tariffTypes: models as TariffType[],
      current: current ? { insurerId: current.insurerId, tariffCode: context.currentTariffCode } : undefined
    });
    if (!computed || !computed.offers.length) {
      throw fail(404, 'NO_PREMIUM_DATA',
        `Aucune prime ${year.year} ne correspond à ce foyer dans les données officielles.`);
    }

    const search = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(MAX_LIMIT,
      Math.max(1, Number.parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
    const names = new Map(context.insured.map((p) => [p.clientUid, p.name]));

    const matching = computed.offers.filter((offer) => !search ||
      offer.insurer.toLowerCase().includes(search) ||
      modelLabel(offer).toLowerCase().includes(search));

    // Les canaux ne dépendent que de la caisse : une seule lecture par caisse.
    const shown = matching.slice(0, limit);
    const channels = new Map<number, Awaited<ReturnType<typeof subscriptionFor>>>();
    for (const insurerId of new Set(shown.map((o) => o.insurerId))) {
      channels.set(insurerId, await subscriptionFor(year.year, insurerId));
    }

    const currentOffer = computed.current;
    res.json({
      source: {
        provider: 'OFSP — primes officielles (priminfo.admin.ch)',
        year: computed.year,
        redistributionYearly: computed.redistributionYearly
      },
      notice: 'Liste fournie à titre d\'information, sans recommandation. ' +
        'Les primes sont celles publiées par l\'OFSP ; vérifiez les conditions auprès de la caisse.',
      location: { label: region.label, canton: region.canton, region: region.region, plz: context.reference.plz },
      insured: context.insured,
      cancellationDeadline: cancellationDeadlineFor(targetYear()),
      effectiveYear: targetYear(),
      totalOffers: matching.length,
      offers: shown.map((offer) => {
        const subscription = channels.get(offer.insurerId);
        return {
          insurerId: offer.insurerId,
          insurer: offer.insurer,
          model: modelLabel(offer),
          tariffType: offer.tariffType,
          typeLabel: TARIFF_TYPE_LABELS[offer.tariffType],
          tariffCode: offer.tariffCode,
          current: Boolean(currentOffer && currentOffer.insurerId === offer.insurerId &&
            currentOffer.tariffCode === offer.tariffCode),
          monthly: offer.monthly.total,
          yearly: offer.yearly.total,
          // Écart factuel avec le contrat actuel, positif quand l'offre coûte moins.
          differenceMonthly: currentOffer
            ? Math.round((currentOffer.monthly.total - offer.monthly.total) * 100) / 100
            : null,
          persons: offer.persons.map((person) => ({
            clientUid: person.ref,
            name: names.get(person.ref) ?? null,
            monthly: person.monthly.total
          })),
          subscription: subscription
            ? { primary: subscription.primary, channels: subscription.channels }
            : { primary: 'POST', channels: ['POST'] }
        };
      }),
      warnings: context.warnings
    });
  } catch (err) {
    sendError(res, err, 'de listing des offres LAMal');
  }
});

/**
 * @swagger
 * /api/lamal/insurers/{insurerId}/subscription:
 *   get:
 *     summary: Comment s'affilier à une caisse
 *     description: >
 *       Lien de souscription en ligne quand la caisse en propose une, sinon
 *       adresse email et postale où envoyer la lettre d'affiliation.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: insurerId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Canaux disponibles }
 *       404: { description: Caisse inconnue ou primes non disponibles }
 */
router.get('/insurers/:insurerId/subscription', async (req: Request, res: Response) => {
  try {
    const year = await activeYear();
    const insurerId = Number.parseInt(req.params.insurerId, 10);
    const subscription = year && Number.isFinite(insurerId)
      ? await subscriptionFor(year.year, insurerId)
      : null;
    if (!subscription) {
      throw fail(404, 'INSURER_NOT_FOUND', 'Caisse inconnue.');
    }
    res.json({
      ...subscription,
      effectiveYear: targetYear(),
      cancellationDeadline: cancellationDeadlineFor(targetYear())
    });
  } catch (err) {
    sendError(res, err, 'de lecture des canaux de souscription');
  }
});

/**
 * Produit une lettre en PDF pour un assuré du foyer.
 *
 * La signature enregistrée sur le site est apposée quand elle existe ; sinon
 * la lettre est laissée à signer à la main, ce qui suffit pour un envoi papier
 * comme pour un scan joint à un email.
 */
async function serveLetter(req: Request, res: Response, kind: LetterKind) {
  try {
    const user = req.authUser!;
    const clientUid = String(req.query.clientUid || '').trim();
    const client = await Client.findOne({ userUid: user.uid, ...(clientUid ? { uid: clientUid } : {}) })
      .sort({ _id: 1 });
    if (!client) {
      throw fail(404, 'CLIENT_NOT_FOUND', 'Cet assuré n\'appartient pas à votre foyer.');
    }

    const year = await activeYear();
    const contract = await Insurance.findOne({
      userUid: user.uid, clientUid: client.uid, type: 'LAMAL', status: 'ACTIVE'
    });

    const holder = await Client.findOne({ userUid: user.uid }).sort({ _id: 1 });
    const signature = holder
      ? (await retrieveDocument(holder.uid, 'SIGNATURE', `lettre ${kind} (app)`).catch(() => null))?.content
      : undefined;

    let recipient: { name: string; lines?: string[] };
    let tariffLabel: string | undefined;
    const franchise = readFranchise(req) ?? contract?.franchise;

    if (kind === 'ENROLMENT') {
      const insurerId = Number.parseInt(String(req.query.insurerId ?? ''), 10);
      if (!year || !Number.isFinite(insurerId)) {
        throw fail(400, 'INSURER_REQUIRED', 'Précisez la caisse choisie (insurerId).');
      }
      const address = await insurerAddress(year.year, insurerId);
      if (!address) {
        throw fail(404, 'INSURER_NOT_FOUND', 'Caisse inconnue.');
      }
      recipient = address;
      const tariffCode = String(req.query.tariffCode || '').trim();
      tariffLabel = String(req.query.model || '').trim() || (tariffCode || undefined);
    } else {
      if (!contract) {
        throw fail(400, 'CURRENT_LAMAL_REQUIRED',
          'Aucun contrat LAMal en vigueur pour cet assuré : il n\'y a rien à résilier.');
      }
      const insurer = year ? await resolveInsurerByName(year.year, contract.provider) : null;
      const address = insurer && year ? await insurerAddress(year.year, insurer.insurerId) : null;
      recipient = address || { name: contract.provider, lines: [] };
    }

    const input = {
      kind,
      client,
      recipient,
      effectiveYear: targetYear(),
      contract: contract || undefined,
      currentInsurerName: contract?.provider,
      franchise,
      tariffLabel,
      employerAccidentCoverage: contract?.employerAccidentCoverage,
      signature
    };
    const pdf = await renderLetter(input);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${letterFilename(input)}"`,
      'Cache-Control': 'no-store, private'
    }).send(pdf);
  } catch (err) {
    sendError(res, err, 'de génération de lettre');
  }
}

/**
 * @swagger
 * /api/lamal/letters/enrolment:
 *   get:
 *     summary: Lettre d'affiliation en PDF, pour une caisse sans souscription en ligne
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: clientUid
 *         schema: { type: string }
 *       - in: query
 *         name: insurerId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: model
 *         schema: { type: string }
 *         description: Libellé du modèle choisi, cité dans la lettre
 *       - in: query
 *         name: franchise
 *         schema: { type: integer }
 *     responses:
 *       200: { description: PDF }
 *       400: { description: Caisse non précisée }
 */
router.get('/letters/enrolment', (req, res) => serveLetter(req, res, 'ENROLMENT'));

/**
 * @swagger
 * /api/lamal/letters/cancellation:
 *   get:
 *     summary: Lettre de résiliation du contrat LAMal en vigueur, en PDF
 *     description: Elle doit être reçue par la caisse au plus tard le 30 novembre.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: clientUid
 *         schema: { type: string }
 *     responses:
 *       200: { description: PDF }
 *       400: { description: Aucun contrat LAMal en vigueur }
 */
router.get('/letters/cancellation', (req, res) => serveLetter(req, res, 'CANCELLATION'));

export { router as lamalRouter };
