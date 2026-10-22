import { Router, Request, Response } from 'express';
import { Client } from '../models/client.model';
import { Insurance } from '../models/insurance.model';
import { IdentityDocument } from '../models/identity-document.model';
import { describeApiError } from '../utils/errors';
import { readClientPayload, serializeClient } from '../utils/client-payload';
import { requireUser } from '../middleware/require-user';
import { PHONE_REQUIRED_MESSAGE } from '../services/household.service';

const router = Router();

/** Nombre maximal de clients par compte : garde-fou contre les créations en masse. */
const MAX_CLIENTS_PER_USER = 20;

// Tout l'espace client est réservé à l'utilisateur authentifié.
router.use(requireUser);

/**
 * @swagger
 * /api/clients:
 *   get:
 *     summary: Lister les clients du compte
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Succès }
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const clients = await Client.find({ userUid: req.authUser!.uid }).sort({ birthdate: 1 });
    res.json({ clients: clients.map(serializeClient) });
  } catch (err) {
    console.error('Erreur de listing des clients:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

/**
 * @swagger
 * /api/clients:
 *   post:
 *     summary: Ajouter un client au compte
 *     description: >
 *       Rattache un nouveau client (membre de la famille) à l'utilisateur
 *       authentifié.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, firstname, birthdate, email, phone, road, plz, location, canton, nationality, avsNum, sexe]
 *             properties:
 *               name: { type: string }
 *               firstname: { type: string }
 *               birthdate: { type: string, format: date }
 *               email: { type: string }
 *               phone: { type: string }
 *               road: { type: string }
 *               plz: { type: string }
 *               location: { type: string }
 *               canton: { type: string }
 *               nationality: { type: string }
 *               avsNum: { type: string }
 *               sexe: { type: string, enum: [M, F, X] }
 *     responses:
 *       201: { description: Client créé }
 *       400: { description: Données invalides }
 *       401: { description: Non authentifié }
 *       409: { description: Limite de clients atteinte }
 */
router.post('/', async (req: Request, res: Response) => {
  const user = req.authUser!;

  // À défaut d'email propre, le membre hérite de celui du titulaire du compte.
  const payload = readClientPayload(req.body, { email: user.email });
  if (payload.error || !payload.values) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: payload.error });
  }

  try {
    const count = await Client.countDocuments({ userUid: user.uid });
    // Le premier assuré du compte en est le contact : son numéro est exigé.
    if (!payload.values.phone && count === 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: PHONE_REQUIRED_MESSAGE
      });
    }
    if (count >= MAX_CLIENTS_PER_USER) {
      return res.status(409).json({
        code: 'TOO_MANY_CLIENTS',
        message: `Un compte ne peut pas dépasser ${MAX_CLIENTS_PER_USER} clients.`
      });
    }

    const client = await Client.create({ ...payload.values, userUid: user.uid });
    res.status(201).json({ client: serializeClient(client) });
  } catch (err) {
    console.error('Erreur de création de client:', err);
    const described = describeApiError(err, 'Ce client existe déjà.');
    res.status(described.status).json({ code: described.code, message: described.message });
  }
});

/**
 * @swagger
 * /api/clients/{uid}:
 *   put:
 *     summary: Modifier un assuré du foyer
 *     description: >
 *       Remplace la fiche de l'assuré. Même corps que la création ; les champs
 *       facultatifs omis sont effacés.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Assuré mis à jour }
 *       400: { description: Données invalides }
 *       404: { description: Introuvable dans ce foyer }
 */
router.put('/:uid', async (req: Request, res: Response) => {
  const user = req.authUser!;

  const payload = readClientPayload(req.body, { email: user.email });
  if (payload.error || !payload.values) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: payload.error });
  }
  const values = payload.values;

  try {
    const client = await Client.findOne({ uid: req.params.uid, userUid: user.uid });
    if (!client) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Assuré introuvable.' });
    }

    // Le titulaire reste le contact du compte : son numéro ne peut pas disparaître.
    const holder = await Client.findOne({ userUid: user.uid }).sort({ _id: 1 });
    if (!values.phone && holder?.uid === client.uid) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: PHONE_REQUIRED_MESSAGE });
    }

    client.set({
      name: values.name,
      firstname: values.firstname,
      birthdate: values.birthdate,
      nationality: values.nationality,
      sexe: values.sexe,
      email: values.email,
      phone: values.phone,
      road: values.road,
      plz: values.plz,
      location: values.location,
      canton: values.canton,
      avsNum: values.avsNum
    });
    await client.save();
    res.json({ client: serializeClient(client) });
  } catch (err) {
    console.error('Erreur de mise à jour de client:', err);
    const described = describeApiError(err, 'Ce client existe déjà.');
    res.status(described.status).json({ code: described.code, message: described.message });
  }
});

/**
 * @swagger
 * /api/clients/{uid}:
 *   delete:
 *     summary: Retirer un assuré du foyer
 *     description: >
 *       Le titulaire du compte ne peut pas être retiré, ni un assuré qui porte
 *       encore des contrats : ils seraient sinon rattachés à personne.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       204: { description: Retiré }
 *       404: { description: Introuvable dans ce foyer }
 *       409: { description: Titulaire du compte, ou contrats encore rattachés }
 */
router.delete('/:uid', async (req: Request, res: Response) => {
  const user = req.authUser!;

  try {
    const client = await Client.findOne({ uid: req.params.uid, userUid: user.uid });
    if (!client) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Assuré introuvable.' });
    }

    const holder = await Client.findOne({ userUid: user.uid }).sort({ _id: 1 });
    if (holder?.uid === client.uid) {
      return res.status(409).json({
        code: 'HOLDER_REQUIRED',
        message: 'Le titulaire du compte ne peut pas être retiré.'
      });
    }
    if (await Insurance.exists({ userUid: user.uid, clientUid: client.uid })) {
      return res.status(409).json({
        code: 'HAS_INSURANCES',
        message: 'Cet assuré a encore des contrats : supprimez-les ou rattachez-les à quelqu\'un d\'autre.'
      });
    }

    // Ses pièces d'identité n'ont plus de raison d'être conservées.
    await IdentityDocument.deleteMany({ clientUid: client.uid });
    await Client.deleteOne({ _id: client._id });
    res.status(204).send();
  } catch (err) {
    console.error('Erreur de suppression de client:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

export { router as clientsRouter };
