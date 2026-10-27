import { Router, Request, Response } from 'express';
import multer from 'multer';
import { tmpdir } from 'os';
import { unlink } from 'fs/promises';
import { Client, IClient } from '../models/client.model';
import {
  Insurance,
  INSURANCE_STATUSES,
  INSURANCE_TYPES,
  InsuranceStatus,
  InsuranceType,
  PremiumFrequency
} from '../models/insurance.model';
import { requireUser } from '../middleware/require-user';
import { escapeRegex } from '../utils/query';
import { describeApiError } from '../utils/errors';
import {
  cancellationDeadline,
  monthlyPremium,
  readInsurancePayload,
  serializeInsurance
} from '../utils/insurance-payload';
import { REMINDER_MILESTONES } from '../models/notification.model';
import { isSupportedDocument } from '../services/document-extraction.service';
import { scanPolicy, scanPolicyText } from '../services/policy-scan.service';

const router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Garde-fou contre les créations en masse, sur le modèle de la limite de clients. */
const MAX_INSURANCES_PER_USER = 200;

/** Champs de tri autorisés : une valeur libre exposerait la structure du document. */
const SORTABLE: Record<string, string> = {
  startDate: 'startDate',
  endDate: 'endDate',
  premium: 'premiumAmount',
  provider: 'provider',
  type: 'type'
};

/** Un contrat scanné de vingt pages pèse une quinzaine de mégaoctets : marge comprise. */
const MAX_SCAN_BYTES = 50 * 1024 * 1024;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: MAX_SCAN_BYTES, files: 1 }
});

router.use(requireUser);

/** Découpe un paramètre multi-valeurs : `?type=LAMAL,MENAGE` ou `?type=LAMAL&type=MENAGE`. */
function readList(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

function readDate(raw: unknown): Date | undefined {
  const value = String(raw ?? '').trim();
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * @swagger
 * /api/insurances:
 *   get:
 *     summary: Assurances du foyer
 *     description: >
 *       Retourne les assurances de tous les clients rattachés au compte
 *       authentifié (le titulaire et les membres de sa famille), avec
 *       filtrage, tri et pagination.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: clientUid
 *         schema: { type: string }
 *         description: Limite à un assuré du foyer
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *         description: "Types séparés par des virgules, ex. LAMAL,MENAGE"
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: "Statuts séparés par des virgules, ex. ACTIVE,PENDING"
 *       - in: query
 *         name: provider
 *         schema: { type: string }
 *         description: Prestataire, correspondance partielle insensible à la casse
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Recherche libre (prestataire, offre, numéro de police, description)
 *       - in: query
 *         name: activeOn
 *         schema: { type: string, format: date }
 *         description: "Contrats en vigueur à cette date. `today` accepté."
 *       - in: query
 *         name: endingBefore
 *         schema: { type: string, format: date }
 *         description: Contrats arrivant à terme avant cette date
 *       - in: query
 *         name: sort
 *         schema: { type: string }
 *         description: "startDate | endDate | premium | provider | type, préfixé de `-` pour décroissant"
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200: { description: Succès }
 *       400: { description: Filtre invalide }
 *       401: { description: Non authentifié }
 *       404: { description: Assuré inconnu dans ce foyer }
 */
router.get('/', async (req: Request, res: Response) => {
  const user = req.authUser!;

  const fail = (code: string, message: string, status = 400) =>
    res.status(status).json({ code, message });

  try {
    // Le foyer est chargé d'abord : il borne la requête et sert à enrichir
    // chaque assurance de son assuré sans repasser par la base (N+1).
    const clients = await Client.find({ userUid: user.uid });
    const clientsByUid = new Map<string, IClient>(clients.map((c) => [c.uid, c]));

    // Le filtre part toujours du compte : aucun paramètre ne permet d'élargir
    // la portée au-delà du foyer de l'utilisateur authentifié.
    const filter: Record<string, unknown> = { userUid: user.uid };

    const clientUid = String(req.query.clientUid || '').trim();
    if (clientUid) {
      if (!clientsByUid.has(clientUid)) {
        return fail('CLIENT_NOT_FOUND', 'Cet assuré n\'appartient pas à votre foyer.', 404);
      }
      filter.clientUid = clientUid;
    }

    const types = readList(req.query.type);
    if (types.length) {
      const unknown = types.filter((t) => !INSURANCE_TYPES.includes(t as InsuranceType));
      if (unknown.length) {
        return fail(
          'INVALID_TYPE',
          `Type d'assurance inconnu : ${unknown.join(', ')}. Valeurs acceptées : ${INSURANCE_TYPES.join(', ')}.`
        );
      }
      filter.type = { $in: types };
    }

    const statuses = readList(req.query.status);
    if (statuses.length) {
      const unknown = statuses.filter((s) => !INSURANCE_STATUSES.includes(s as InsuranceStatus));
      if (unknown.length) {
        return fail(
          'INVALID_STATUS',
          `Statut inconnu : ${unknown.join(', ')}. Valeurs acceptées : ${INSURANCE_STATUSES.join(', ')}.`
        );
      }
      filter.status = { $in: statuses };
    }

    const provider = String(req.query.provider || '').trim();
    if (provider) {
      filter.provider = { $regex: escapeRegex(provider), $options: 'i' };
    }

    const search = String(req.query.q || '').trim();
    if (search) {
      const regex = { $regex: escapeRegex(search), $options: 'i' };
      filter.$or = [
        { provider: regex },
        { productName: regex },
        { policyNumber: regex },
        { description: regex }
      ];
    }

    // « En vigueur à une date » : commencé, et pas encore terminé. Le $or sur
    // l'absence de date de fin ne couvre plus que d'éventuels documents créés
    // avant que endDate ne devienne obligatoire.
    const rawActiveOn = String(req.query.activeOn || '').trim();
    if (rawActiveOn) {
      const activeOn = rawActiveOn.toLowerCase() === 'today' ? new Date() : readDate(rawActiveOn);
      if (!activeOn) {
        return fail('INVALID_DATE', 'Le paramètre activeOn n\'est pas une date valide.');
      }
      filter.startDate = { $lte: activeOn };
      filter.$and = [
        { $or: [{ endDate: { $gte: activeOn } }, { endDate: { $exists: false } }, { endDate: null }] }
      ];
    }

    const rawEndingBefore = String(req.query.endingBefore || '').trim();
    if (rawEndingBefore) {
      const endingBefore = readDate(rawEndingBefore);
      if (!endingBefore) {
        return fail('INVALID_DATE', 'Le paramètre endingBefore n\'est pas une date valide.');
      }
      filter.endDate = { $ne: null, $lte: endingBefore };
    }

    const rawSort = String(req.query.sort || '-startDate');
    const descending = rawSort.startsWith('-');
    const sortField = SORTABLE[rawSort.replace(/^-/, '')];
    if (!sortField) {
      return fail(
        'INVALID_SORT',
        `Tri inconnu. Valeurs acceptées : ${Object.keys(SORTABLE).join(', ')}, préfixées de « - » pour décroissant.`
      );
    }

    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT)
    );

    const [insurances, total, premiumGroups] = await Promise.all([
      Insurance.find(filter)
        .sort({ [sortField]: descending ? -1 : 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Insurance.countDocuments(filter),
      // Le total des primes porte sur l'ensemble du filtre, pas sur la page
      // affichée : sinon le chiffre change en tournant les pages.
      Insurance.aggregate<{ _id: PremiumFrequency; amount: number }>([
        { $match: filter },
        { $group: { _id: '$premiumFrequency', amount: { $sum: '$premiumAmount' } } }
      ])
    ]);

    const monthlyTotal = premiumGroups.reduce(
      (sum, group) => sum + monthlyPremium(group.amount, group._id),
      0
    );

    res.json({
      insurances: insurances.map((insurance) =>
        serializeInsurance(insurance, clientsByUid.get(insurance.clientUid))
      ),
      page: { page, pageSize: limit, total },
      summary: {
        total,
        monthlyPremium: Number(monthlyTotal.toFixed(2)),
        yearlyPremium: Number((monthlyTotal * 12).toFixed(2)),
        currency: insurances[0]?.currency || 'CHF'
      }
    });
  } catch (err) {
    console.error('Erreur de listing des assurances:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

/**
 * @swagger
 * /api/insurances:
 *   post:
 *     summary: Ajouter une assurance à un assuré du foyer
 *     description: >
 *       Rattache un contrat à un client de l'utilisateur authentifié.
 *       Le titulaire (`userUid`) est déduit du jeton, jamais du corps.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientUid, provider, productName, type, policyNumber, startDate, endDate, premiumAmount]
 *             properties:
 *               clientUid: { type: string, description: Assuré, doit appartenir au foyer }
 *               provider: { type: string, example: Helvetia }
 *               productName: { type: string, example: Primeo Basic }
 *               type:
 *                 type: string
 *                 enum: [LAMAL, COMPLEMENTAIRE_SANTE, ACCIDENT, INDEMNITE_JOURNALIERE, VIE, RC_PRIVEE, MENAGE, BATIMENT, VEHICULE, PROTECTION_JURIDIQUE, VOYAGE, ANIMAUX, AUTRE]
 *               description: { type: string }
 *               policyNumber: { type: string }
 *               startDate: { type: string, format: date }
 *               endDate: { type: string, format: date, description: Fin de la période contractuelle en cours }
 *               status: { type: string, enum: [ACTIVE, PENDING, EXPIRED, CANCELLED], default: ACTIVE }
 *               premiumAmount: { type: number }
 *               premiumFrequency: { type: string, enum: [MENSUEL, TRIMESTRIEL, SEMESTRIEL, ANNUEL], default: MENSUEL }
 *               currency: { type: string, default: CHF }
 *               franchise: { type: number }
 *               coverageAmount: { type: number }
 *               cancellationNoticeMonths: { type: number }
 *               autoRenew: { type: boolean, default: true }
 *               tariffType:
 *                 type: string
 *                 enum: [BASE, HAM, HMO, DIV]
 *                 description: >
 *                   LAMal uniquement — modèle : standard, médecin de famille,
 *                   HMO ou autre. Sans lui, la comparaison suppose le standard.
 *               tariffCode:
 *                 type: string
 *                 description: >
 *                   LAMal uniquement — code de l'offre au catalogue de l'OFSP,
 *                   obtenu via /api/comparison/lamal-models.
 *               employerAccidentCoverage:
 *                 type: boolean
 *                 default: false
 *                 description: >
 *                   LAMal uniquement — l'assuré est couvert contre les accidents
 *                   par son employeur, sa LAMal exclut donc cette couverture.
 *               notes: { type: string }
 *     responses:
 *       201: { description: Assurance créée }
 *       400: { description: Données invalides }
 *       401: { description: Non authentifié }
 *       404: { description: Assuré inconnu dans ce foyer }
 *       409: { description: Limite d'assurances atteinte }
 */
router.post('/', async (req: Request, res: Response) => {
  const user = req.authUser!;

  const payload = readInsurancePayload(req.body);
  if (payload.error || !payload.values) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: payload.error });
  }
  const values = payload.values;

  if (!values.clientUid) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'L\'assuré (clientUid) est obligatoire.'
    });
  }

  try {
    // L'assuré doit appartenir au foyer : c'est ce contrôle qui empêche de
    // greffer un contrat sur le client de quelqu'un d'autre.
    const client = await Client.findOne({ uid: values.clientUid, userUid: user.uid });
    if (!client) {
      return res.status(404).json({
        code: 'CLIENT_NOT_FOUND',
        message: 'Cet assuré n\'appartient pas à votre foyer.'
      });
    }

    const count = await Insurance.countDocuments({ userUid: user.uid });
    if (count >= MAX_INSURANCES_PER_USER) {
      return res.status(409).json({
        code: 'TOO_MANY_INSURANCES',
        message: `Un compte ne peut pas dépasser ${MAX_INSURANCES_PER_USER} assurances.`
      });
    }

    const insurance = await Insurance.create({ ...values, userUid: user.uid });
    res.status(201).json({ insurance: serializeInsurance(insurance, client) });
  } catch (err) {
    console.error('Erreur de création d\'assurance:', err);
    const described = describeApiError(err, 'Cette assurance existe déjà.');
    res.status(described.status).json({ code: described.code, message: described.message });
  }
});

/**
 * @swagger
 * /api/insurances/filters:
 *   get:
 *     summary: Valeurs disponibles pour le filtrage
 *     description: >
 *       Énumérations complètes et prestataires réellement présents dans le
 *       foyer, pour alimenter les listes déroulantes de l'application mobile.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Succès }
 */
router.get('/filters', async (req: Request, res: Response) => {
  const user = req.authUser!;

  try {
    const [providers, clients] = await Promise.all([
      Insurance.distinct('provider', { userUid: user.uid }),
      Client.find({ userUid: user.uid }).sort({ birthdate: 1 })
    ]);

    res.json({
      types: INSURANCE_TYPES,
      statuses: INSURANCE_STATUSES,
      providers: providers.sort(),
      insured: clients.map((c) => ({ uid: c.uid, name: c.name, firstname: c.firstname })),
      sort: Object.keys(SORTABLE)
    });
  } catch (err) {
    console.error('Erreur de chargement des filtres:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

/**
 * @swagger
 * /api/insurances/scan:
 *   post:
 *     summary: Lire une police photographiée ou un PDF
 *     description: >
 *       Reconnaissance de texte puis analyse du document. Rien n'est
 *       enregistré : la réponse est un brouillon à faire vérifier par
 *       l'assuré, puis à envoyer à POST /api/insurances. Tous les types
 *       d'assurance sont acceptés ; seule une police LAMal passe par la
 *       lecture assistée, validée contre le catalogue officiel.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [document]
 *             properties:
 *               document: { type: string, format: binary }
 *               type: { type: string, description: Type connu de l'assuré, sinon deviné }
 *     responses:
 *       200: { description: Brouillon de contrat }
 *       400: { description: Fichier absent ou format non pris en charge }
 *       413: { description: Fichier trop lourd }
 *       422: { description: Document illisible }
 */
router.post('/scan', (req: Request, res: Response) => {
  upload.single('document')(req, res, async (uploadErr: unknown) => {
    if (uploadErr instanceof multer.MulterError) {
      const tooLarge = uploadErr.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        code: tooLarge ? 'FILE_TOO_LARGE' : 'INVALID_UPLOAD',
        message: tooLarge
          ? `Le fichier dépasse ${Math.round(MAX_SCAN_BYTES / (1024 * 1024))} Mo.`
          : 'Envoyez un seul fichier, dans le champ « document ».'
      });
    }
    if (uploadErr) {
      console.error('Erreur de réception de document:', uploadErr);
      return res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ code: 'FILE_REQUIRED', message: 'Aucun fichier reçu.' });
    }

    try {
      if (!isSupportedDocument(file.mimetype, file.originalname)) {
        return res.status(400).json({
          code: 'UNSUPPORTED_FORMAT',
          message: 'Format non pris en charge : envoyez une photo (JPEG, PNG, HEIC) ou un PDF.'
        });
      }

      const rawType = String(req.body?.type || '').trim().toUpperCase();
      if (rawType && !INSURANCE_TYPES.includes(rawType as InsuranceType)) {
        return res.status(400).json({
          code: 'INVALID_TYPE',
          message: `Type d'assurance inconnu. Valeurs acceptées : ${INSURANCE_TYPES.join(', ')}.`
        });
      }

      const scan = await scanPolicy({
        userUid: req.authUser!.uid,
        path: file.path,
        mimetype: file.mimetype,
        filename: file.originalname,
        requestedType: (rawType || undefined) as InsuranceType | undefined
      });
      res.json(scan);
    } catch (err) {
      // Les erreurs de lecture portent déjà un message destiné à l'assuré.
      res.status(422).json({ code: 'UNREADABLE_DOCUMENT', message: (err as Error).message });
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  });
});

/**
 * Un contrat de plusieurs dizaines de pages fait 100 000 à 150 000 caractères.
 * La borne protège seulement contre un envoi aberrant.
 */
const MAX_SCAN_TEXT_CHARS = 300_000;

/**
 * @swagger
 * /api/insurances/scan-text:
 *   post:
 *     summary: Lire une police à partir du texte reconnu sur le téléphone
 *     description: >
 *       Même analyse que /api/insurances/scan, mais l'application a fait la
 *       reconnaissance de texte elle-même : seul le texte est envoyé. Rien
 *       n'est enregistré.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text]
 *             properties:
 *               text: { type: string, maxLength: 30000 }
 *               type: { type: string, description: Type connu de l'assuré, sinon deviné }
 *     responses:
 *       200: { description: Brouillon de contrat }
 *       400: { description: Texte absent, trop long, ou type inconnu }
 */
router.post('/scan-text', async (req: Request, res: Response) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) {
    return res.status(400).json({ code: 'TEXT_REQUIRED', message: 'Aucun texte reçu.' });
  }
  if (text.length > MAX_SCAN_TEXT_CHARS) {
    return res.status(400).json({
      code: 'TEXT_TOO_LONG',
      message: `Le texte dépasse ${MAX_SCAN_TEXT_CHARS} caractères : ce document est trop long pour une police.`
    });
  }

  const rawType = String(req.body?.type || '').trim().toUpperCase();
  if (rawType && !INSURANCE_TYPES.includes(rawType as InsuranceType)) {
    return res.status(400).json({
      code: 'INVALID_TYPE',
      message: `Type d'assurance inconnu. Valeurs acceptées : ${INSURANCE_TYPES.join(', ')}.`
    });
  }

  try {
    res.json(await scanPolicyText({
      userUid: req.authUser!.uid,
      text,
      requestedType: (rawType || undefined) as InsuranceType | undefined
    }));
  } catch (err) {
    console.error('Erreur de lecture de texte de police:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

/**
 * @swagger
 * /api/insurances/deadlines:
 *   get:
 *     summary: Échéances à venir du foyer
 *     description: >
 *       Pour chaque contrat en vigueur, la prochaine date qui demande une
 *       action : la limite de résiliation quand un préavis est connu (pour la
 *       LAMal, toujours le 30 novembre), sinon le terme d'un contrat qui ne se
 *       reconduit pas. Les dates de rappel suivent les paliers du serveur
 *       (90, 30 et 7 jours avant), pour que l'application planifie ses
 *       notifications locales les mêmes jours que les emails.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Échéances triées de la plus proche à la plus lointaine }
 */
router.get('/deadlines', async (req: Request, res: Response) => {
  const user = req.authUser!;

  try {
    const [insurances, clients] = await Promise.all([
      Insurance.find({ userUid: user.uid, status: 'ACTIVE' }),
      Client.find({ userUid: user.uid })
    ]);
    const clientsByUid = new Map<string, IClient>(clients.map((c) => [c.uid, c]));
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    const deadlines = insurances.flatMap((insurance) => {
      const cancellation = cancellationDeadline(insurance);
      // Sans préavis, seul un contrat qui s'arrête de lui-même a une date à signaler.
      const date = cancellation ?? (insurance.autoRenew ? undefined : insurance.endDate);
      if (!date) {
        return [];
      }
      const daysLeft = Math.round((date.getTime() - today) / MS_PER_DAY);
      if (daysLeft < 0) {
        return [];
      }

      const client = clientsByUid.get(insurance.clientUid);
      return [{
        insuranceUid: insurance.uid,
        kind: cancellation ? 'CANCELLATION' : 'EXPIRY',
        type: insurance.type,
        provider: insurance.provider,
        productName: insurance.productName,
        policyNumber: insurance.policyNumber,
        insured: client
          ? { uid: client.uid, name: client.name, firstname: client.firstname }
          : { uid: insurance.clientUid },
        endDate: insurance.endDate,
        deadline: date,
        daysLeft,
        reminders: REMINDER_MILESTONES
          .map((days) => ({ daysBefore: days, date: new Date(date.getTime() - days * MS_PER_DAY) }))
          .filter((reminder) => reminder.date.getTime() >= today)
      }];
    });

    deadlines.sort((a, b) => a.deadline.getTime() - b.deadline.getTime());
    res.json({ milestones: REMINDER_MILESTONES, deadlines });
  } catch (err) {
    console.error('Erreur de calcul des échéances:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

/**
 * @swagger
 * /api/insurances/{uid}:
 *   get:
 *     summary: Détail d'une assurance
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Succès }
 *       404: { description: Introuvable dans ce foyer }
 */
router.get('/:uid', async (req: Request, res: Response) => {
  const user = req.authUser!;

  try {
    // Le userUid fait partie du critère : une assurance d'un autre foyer est
    // introuvable, et non « interdite » — rien ne fuit sur son existence.
    const insurance = await Insurance.findOne({ uid: req.params.uid, userUid: user.uid });
    if (!insurance) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Assurance introuvable.' });
    }

    const client = await Client.findOne({ uid: insurance.clientUid });
    res.json({ insurance: serializeInsurance(insurance, client || undefined) });
  } catch (err) {
    console.error('Erreur de chargement d\'assurance:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

/**
 * @swagger
 * /api/insurances/{uid}:
 *   put:
 *     summary: Modifier une assurance
 *     description: >
 *       Remplace les champs du contrat. Le corps suit le même schéma que la
 *       création : les champs facultatifs omis sont remis à leur valeur par
 *       défaut ou effacés.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Assurance mise à jour }
 *       400: { description: Données invalides }
 *       404: { description: Introuvable dans ce foyer }
 */
router.put('/:uid', async (req: Request, res: Response) => {
  const user = req.authUser!;

  const payload = readInsurancePayload(req.body);
  if (payload.error || !payload.values) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: payload.error });
  }
  const values = payload.values;

  try {
    const insurance = await Insurance.findOne({ uid: req.params.uid, userUid: user.uid });
    if (!insurance) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Assurance introuvable.' });
    }

    // Un contrat peut être déplacé vers un autre membre du foyer, jamais hors de celui-ci.
    const targetClientUid = values.clientUid || insurance.clientUid;
    const client = await Client.findOne({ uid: targetClientUid, userUid: user.uid });
    if (!client) {
      return res.status(404).json({
        code: 'CLIENT_NOT_FOUND',
        message: 'Cet assuré n\'appartient pas à votre foyer.'
      });
    }

    insurance.clientUid = targetClientUid;
    insurance.provider = values.provider;
    insurance.productName = values.productName;
    insurance.type = values.type as typeof insurance.type;
    insurance.description = values.description;
    insurance.policyNumber = values.policyNumber;
    insurance.startDate = values.startDate;
    insurance.endDate = values.endDate;
    insurance.premiumAmount = values.premiumAmount as number;
    insurance.franchise = values.franchise;
    insurance.coverageAmount = values.coverageAmount;
    insurance.cancellationNoticeMonths = values.cancellationNoticeMonths;
    insurance.notes = values.notes;
    // Champs à défaut : une omission vaut retour au défaut, pas conservation.
    insurance.status = (values.status || 'ACTIVE') as typeof insurance.status;
    insurance.premiumFrequency = (values.premiumFrequency || 'MENSUEL') as typeof insurance.premiumFrequency;
    insurance.currency = values.currency || 'CHF';
    insurance.autoRenew = values.autoRenew === undefined ? true : values.autoRenew;
    insurance.employerAccidentCoverage = values.employerAccidentCoverage === undefined
      ? false
      : values.employerAccidentCoverage;
    insurance.tariffType = values.tariffType as typeof insurance.tariffType;
    insurance.tariffCode = values.tariffCode;

    await insurance.save();
    res.json({ insurance: serializeInsurance(insurance, client) });
  } catch (err) {
    console.error('Erreur de mise à jour d\'assurance:', err);
    const described = describeApiError(err, 'Cette assurance existe déjà.');
    res.status(described.status).json({ code: described.code, message: described.message });
  }
});

/**
 * @swagger
 * /api/insurances/{uid}:
 *   delete:
 *     summary: Supprimer une assurance
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: Supprimée }
 *       404: { description: Introuvable dans ce foyer }
 */
router.delete('/:uid', async (req: Request, res: Response) => {
  const user = req.authUser!;

  try {
    // La suppression est définitive : un contrat qu'on souhaite conserver pour
    // mémoire se passe en statut CANCELLED plutôt que de disparaître.
    const result = await Insurance.deleteOne({ uid: req.params.uid, userUid: user.uid });
    if (result.deletedCount === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Assurance introuvable.' });
    }
    res.status(204).send();
  } catch (err) {
    console.error('Erreur de suppression d\'assurance:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

export { router as insurancesRouter };
