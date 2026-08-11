import { Router, Request, Response } from 'express';
import { User, IUser } from '../models/user.model';
import { Client } from '../models/client.model';
import { UserToken, USER_TOKEN_TTL_SECONDS } from '../models/user-token.model';
import { generateSalt, hashPassword, verifyPassword } from '../utils/password';
import { generateToken, hashToken } from '../utils/token';
import { sendConfirmationEmail } from '../utils/mailer';
import { resolveBaseUrl } from '../utils/base-url';
import { emailConfirmationRequired } from '../config/features';
import { describeApiError } from '../utils/errors';
import { readClientPayload, serializeClient } from '../utils/client-payload';
import { requireUser } from '../middleware/require-user';
import { PHONE_REQUIRED_MESSAGE } from '../services/household.service';
import { renderEmailConfirmationPage } from '../views/email-confirmation.view';

const router = Router();

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_TOKEN_TTL_MS = 1000 * 60 * 60 * 24; // 24 heures
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function serializeUser(user: IUser) {
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    creationDate: user.creationDate,
    lastLoginDate: user.lastLoginDate
  };
}

/** Génère un jeton de confirmation et le pose sur l'utilisateur (non sauvegardé). */
function issueEmailToken(user: IUser): string {
  const token = generateToken();
  user.emailTokenHash = hashToken(token);
  user.emailTokenExpiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_MS);
  return token;
}

async function issueSessionToken(user: IUser): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + USER_TOKEN_TTL_SECONDS * 1000);

  await UserToken.create({ tokenHash: hashToken(token), userUid: user.uid, expiresAt });
  return { token, expiresAt };
}

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Créer un compte
 *     description: >
 *       Crée l'utilisateur (md_user) et son client titulaire (md_client),
 *       puis envoie l'email de confirmation. Le login reste refusé tant que
 *       l'adresse n'est pas confirmée.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, client]
 *             properties:
 *               email: { type: string }
 *               password: { type: string, minLength: 8 }
 *               client:
 *                 type: object
 *                 required: [name, firstname, birthdate, phone, road, plz, location, canton, nationality, avsNum, sexe]
 *                 properties:
 *                   name: { type: string }
 *                   firstname: { type: string }
 *                   birthdate: { type: string, format: date }
 *                   email: { type: string }
 *                   phone: { type: string }
 *                   road: { type: string }
 *                   plz: { type: string }
 *                   location: { type: string }
 *                   canton: { type: string }
 *                   nationality: { type: string }
 *                   avsNum: { type: string }
 *                   sexe: { type: string, enum: [M, F, X] }
 *     responses:
 *       201: { description: Compte créé, email de confirmation envoyé }
 *       400: { description: Données invalides }
 *       409: { description: Email déjà utilisé }
 */
router.post('/register', async (req: Request, res: Response) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', message: 'Adresse email invalide.' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      code: 'WEAK_PASSWORD',
      message: `Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`
    });
  }

  // Le client titulaire hérite de l'email du compte s'il n'en fournit pas.
  const payload = readClientPayload(req.body?.client, { email });
  if (payload.error || !payload.values) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: payload.error });
  }

  // Facultatif pour les membres ajoutés ensuite, mais exigé du titulaire :
  // c'est le contact du compte. Le modèle ne peut pas distinguer les deux cas.
  if (!payload.values.phone) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: PHONE_REQUIRED_MESSAGE
    });
  }

  if (await User.exists({ email })) {
    return res.status(409).json({ code: 'EMAIL_TAKEN', message: 'Cet email est déjà utilisé.' });
  }

  const confirmationRequired = emailConfirmationRequired();

  let user: IUser | null = null;
  try {
    const salt = generateSalt();
    user = new User({ email, salt, password: await hashPassword(password, salt) });

    // Le jeton n'est émis que si la confirmation est exigée : inutile
    // d'encombrer le compte d'un jeton que personne n'utilisera.
    const emailToken = confirmationRequired ? issueEmailToken(user) : undefined;
    if (!confirmationRequired) {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
    }
    await user.save();

    // Pas de transaction : Mongo n'est pas forcément en replica set. En cas
    // d'échec sur le client, l'utilisateur tout juste créé est retiré pour ne
    // pas laisser un compte orphelin qui bloquerait une nouvelle inscription.
    try {
      await Client.create({ ...payload.values, userUid: user.uid });
    } catch (clientErr) {
      await User.deleteOne({ uid: user.uid });
      throw clientErr;
    }

    // Un envoi raté ne remet pas en cause l'inscription : le compte existe,
    // l'utilisateur peut demander un renvoi via /resend-confirmation.
    const emailSent = emailToken
      ? await sendConfirmationEmail(user.email, emailToken, resolveBaseUrl(req))
      : false;

    res.status(201).json({
      message: confirmationRequired
        ? 'Compte créé. Confirmez votre email pour vous connecter.'
        : 'Compte créé. Vous pouvez vous connecter immédiatement.',
      emailSent,
      emailConfirmationRequired: confirmationRequired,
      user: serializeUser(user)
    });
  } catch (err) {
    console.error('Erreur d\'inscription:', err);
    const described = describeApiError(err, 'Cet email est déjà utilisé.');
    res.status(described.status).json({ code: described.code, message: described.message });
  }
});

/**
 * @swagger
 * /api/auth/confirm-email:
 *   get:
 *     summary: Confirmer une adresse email
 *     description: Ouvert depuis le lien reçu par email ; renvoie une page HTML.
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Email confirmé }
 *       400: { description: Lien invalide ou expiré }
 */
router.get('/confirm-email', async (req: Request, res: Response) => {
  const token = String(req.query.token || '');

  const invalid = () =>
    res.status(400).type('html').send(renderEmailConfirmationPage({
      success: false,
      message: 'Ce lien de confirmation est invalide ou a expiré. Demandez-en un nouveau depuis l\'application.'
    }));

  if (!token) {
    return invalid();
  }

  try {
    const user = await User.findOne({ emailTokenHash: hashToken(token) })
      .select('+emailTokenHash +emailTokenExpiresAt');

    if (!user || !user.emailTokenExpiresAt || user.emailTokenExpiresAt.getTime() <= Date.now()) {
      return invalid();
    }

    // Jeton à usage unique : consommé même si l'email était déjà confirmé.
    user.emailVerified = true;
    user.emailVerifiedAt = user.emailVerifiedAt || new Date();
    user.emailTokenHash = undefined;
    user.emailTokenExpiresAt = undefined;
    await user.save();

    res.type('html').send(renderEmailConfirmationPage({
      success: true,
      message: 'Votre adresse email est confirmée. Vous pouvez maintenant vous connecter depuis l\'application.'
    }));
  } catch (err) {
    console.error('Erreur de confirmation d\'email:', err);
    res.status(500).type('html').send(renderEmailConfirmationPage({
      success: false,
      message: 'Erreur serveur. Réessayez plus tard.'
    }));
  }
});

/**
 * @swagger
 * /api/auth/resend-confirmation:
 *   post:
 *     summary: Renvoyer l'email de confirmation
 *     responses:
 *       200: { description: Réponse générique, qu'un compte existe ou non }
 */
router.post('/resend-confirmation', async (req: Request, res: Response) => {
  const email = String(req.body?.email || '').trim().toLowerCase();

  // Réponse identique dans tous les cas : ne pas révéler quels emails existent.
  const generic = () => res.json({
    message: 'Si un compte existe pour cette adresse et n\'est pas confirmé, un email vient d\'être envoyé.'
  });

  if (!EMAIL_PATTERN.test(email)) {
    return generic();
  }

  try {
    const user = await User.findOne({ email }).select('+emailTokenHash +emailTokenExpiresAt');
    if (user && !user.emailVerified && !user.blocked) {
      const token = issueEmailToken(user);
      await user.save();
      await sendConfirmationEmail(user.email, token, resolveBaseUrl(req));
    }
    generic();
  } catch (err) {
    console.error('Erreur de renvoi de confirmation:', err);
    generic();
  }
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Connexion utilisateur
 *     description: Retourne un jeton Bearer et les clients rattachés au compte.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200: { description: Connecté }
 *       401: { description: Identifiants invalides }
 *       403: { description: Email non confirmé ou compte bloqué }
 */
router.post('/login', async (req: Request, res: Response) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  const fail = () => res.status(401).json({
    code: 'INVALID_CREDENTIALS',
    message: 'Email ou mot de passe incorrect.'
  });

  try {
    const user = await User.findOne({ email }).select('+password +salt');
    if (!user) {
      return fail();
    }

    if (!await verifyPassword(password, user.salt, user.password)) {
      return fail();
    }

    if (user.blocked) {
      return res.status(403).json({ code: 'ACCOUNT_BLOCKED', message: 'Ce compte est bloqué.' });
    }
    // Barrière levée quand la confirmation n'est pas exigée : les comptes
    // créés alors sont marqués confirmés d'office, mais un compte plus ancien
    // resté non confirmé doit pouvoir se connecter lui aussi.
    if (emailConfirmationRequired() && !user.emailVerified) {
      return res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Confirmez votre adresse email avant de vous connecter.'
      });
    }

    const session = await issueSessionToken(user);

    user.lastLoginDate = new Date();
    await user.save();

    const clients = await Client.find({ userUid: user.uid }).sort({ birthdate: 1 });

    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: serializeUser(user),
      clients: clients.map(serializeClient)
    });
  } catch (err) {
    console.error('Erreur de login:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Déconnexion
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       204: { description: Jeton révoqué }
 */
router.post('/logout', requireUser, async (req: Request, res: Response) => {
  const token = (req.headers.authorization || '').split(' ')[1] || '';

  try {
    await UserToken.deleteOne({ tokenHash: hashToken(token) });
    res.status(204).send();
  } catch (err) {
    console.error('Erreur de déconnexion:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Compte courant et clients rattachés
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Succès }
 *       401: { description: Non authentifié }
 */
router.get('/me', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.authUser!;
    const clients = await Client.find({ userUid: user.uid }).sort({ birthdate: 1 });
    res.json({ user: serializeUser(user), clients: clients.map(serializeClient) });
  } catch (err) {
    console.error('Erreur de chargement du compte:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

export { router as authRouter };
