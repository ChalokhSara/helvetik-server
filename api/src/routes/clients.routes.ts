import { Router, Request, Response } from 'express';
import { Client } from '../models/client.model';
import { describeApiError } from '../utils/errors';
import { readClientPayload, serializeClient } from '../utils/client-payload';
import { requireUser } from '../middleware/require-user';

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

export { router as clientsRouter };
