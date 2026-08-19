import express, { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { tmpdir } from 'os';
import { unlink } from 'fs/promises';
import { User, IUser } from '../models/user.model';
import { Client, IClient } from '../models/client.model';
import { Insurance, IInsurance } from '../models/insurance.model';
import { Feedback, INTEREST_LEVELS, InterestLevel } from '../models/feedback.model';
import { generateSalt, hashPassword, verifyPassword } from '../utils/password';
import { generateToken, hashToken } from '../utils/token';
import { sendConfirmationEmail } from '../utils/mailer';
import { resolveBaseUrl } from '../utils/base-url';
import { emailConfirmationRequired } from '../config/features';
import { csrfToken, verifyCsrf, isCsrfValid, CSRF_REJECTION_MESSAGE } from '../utils/csrf';
import {
  describeExtraction,
  extractFromDocument,
  isSupportedDocument,
  ExtractionResult
} from '../services/document-extraction.service';
import { readClientPayload } from '../utils/client-payload';
import { completeAddress, suggestAddresses } from '../services/address.service';
import {
  DocumentKind,
  IDENTITY_KINDS,
  IIdentityDocument,
  KIND_LABELS
} from '../models/identity-document.model';
import {
  deleteDocument,
  documentsByClient,
  hasDocument,
  isAcceptedDocument,
  listDocuments,
  retrieveDocument,
  storeDocument,
  VaultError
} from '../services/document-vault.service';
import {
  cancellationDeadlineFor,
  LetterKind,
  letterFilename,
  letterTitle,
  renderLetter
} from '../services/letter.service';
import { readInsurancePayload } from '../utils/insurance-payload';
import { monthlyPremium, cancellationDeadline } from '../utils/insurance-payload';
import {
  ageAt,
  buildHouseholdContext,
  HouseholdError,
  nearestLegalFranchise,
  isFirstClientOfHousehold,
  describeClient,
  PHONE_REQUIRED_MESSAGE
} from '../services/household.service';
import { modelLabel, optimiseLamal } from '../services/lamal-optimisation.service';
import {
  Catalogue,
  catalogueFor,
  InsurerMailingAddress,
  insurerAddressByName,
  premiumFor
} from '../services/premium-catalogue.service';
import { activeYear } from '../services/premium-import.service';
import { readPolicy } from '../services/policy-llm.service';
import {
  dispatchLetter,
  epostConfig
} from '../services/epost.service';
import { LetterDispatch } from '../models/letter-dispatch.model';
import * as views from '../views/site/pages';
import { StoredSide, Values } from '../views/site/forms';

const router = Router();

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_TOKEN_TTL_MS = 1000 * 60 * 60 * 24;
const MAX_CLIENTS_PER_USER = 20;
const MAX_INSURANCES_PER_USER = 200;
const OFFERS_SHOWN = 15;

/** Dépôt de document : une photo de téléphone dépasse rarement quelques mégaoctets. */
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 }
});

// Les formulaires postent en urlencoded ; chaque mutation porte le jeton CSRF.
// Les envois multipart font exception : leur corps n'est analysé qu'après
// multer, la vérification a donc lieu dans la route concernée.
router.use(express.urlencoded({ extended: false }));
router.use((req: Request, res: Response, next: NextFunction) =>
  req.is('multipart/form-data') ? next() : verifyCsrf(req, res, next));

/** Vérification CSRF après multer, avec effacement du fichier en cas de rejet. */
async function verifyUploadCsrf(req: Request, res: Response, next: NextFunction) {
  if (isCsrfValid(req)) {
    return next();
  }
  if (req.file) {
    await unlink(req.file.path).catch(() => undefined);
  }
  res.status(403).type('text/plain').send(CSRF_REJECTION_MESSAGE);
}

/**
 * Le site utilise une session par cookie, là où l'application mobile utilise
 * un jeton Bearer. Deux portes d'entrée, les mêmes comptes et les mêmes règles.
 */
async function currentUser(req: Request): Promise<IUser | null> {
  if (!req.session.siteUserUid) {
    return null;
  }
  const user = await User.findOne({ uid: req.session.siteUserUid });
  if (!user || user.blocked) {
    return null;
  }
  return user;
}

async function requireSiteUser(req: Request, res: Response, next: NextFunction) {
  const user = await currentUser(req);
  if (!user) {
    // La session a pu expirer ou le compte être bloqué entre-temps.
    req.session.siteUserUid = undefined;
    return res.redirect('/connexion');
  }
  req.siteUser = user;
  next();
}

function fieldValues(body: Record<string, unknown>, names: string[]): Values {
  const values: Values = {};
  for (const name of names) {
    values[name] = String(body[name] ?? '').trim();
  }
  return values;
}

const CLIENT_FIELDS = ['firstname', 'name', 'birthdate', 'sexe', 'nationality', 'avsNum',
  'email', 'phone', 'road', 'plz', 'location', 'canton'];
const INSURANCE_FIELDS = ['clientUid', 'provider', 'productName', 'type', 'description',
  'policyNumber', 'startDate', 'endDate', 'status', 'premiumAmount', 'premiumFrequency',
  'franchise', 'coverageAmount', 'cancellationNoticeMonths', 'tariffType', 'tariffCode'];

/** Reporte les champs reconnus, sans écraser une saisie existante. */
function applyExtraction(values: Values, result: ExtractionResult, keys: string[]): Values {
  const fields = result.fields as Record<string, { value: string } | undefined>;
  for (const key of keys) {
    const field = fields[key];
    if (field && !values[key]) {
      values[key] = field.value;
    }
  }
  return values;
}

function applyToClient(values: Values, result: ExtractionResult): Values {
  return applyExtraction(values, result,
    ['avsNum', 'birthdate', 'firstname', 'name', 'sexe', 'nationality', 'plz', 'location']);
}

function applyToInsurance(values: Values, result: ExtractionResult): Values {
  return applyExtraction(values, result,
    ['provider', 'policyNumber', 'premiumAmount', 'franchise']);
}

/**
 * Résumé de ce qui a été tiré d'une police, à afficher au-dessus du formulaire.
 *
 * Distinct de `describeExtraction` : ce qui compte ici n'est pas ce que les
 * motifs textuels ont vu, mais ce que la lecture assistée a su rattacher au
 * catalogue officiel — c'est cela qui remplit réellement le formulaire.
 */
function describePolicyReading(result: ExtractionResult, recognised: string[]): string {
  const source = result.source === 'PDF' ? 'votre document' : 'votre photo';
  if (!recognised.length) {
    return `Rien n'a pu être tiré de ${source} : renseignez le contrat à la main.`;
  }

  const unique = [...new Set(recognised)];
  return `Lu depuis ${source} : ${unique.join(', ')}. ` +
    'Vérifiez chaque champ avant d\'enregistrer.';
}

/**
 * Traduit une erreur Mongoose en message affichable, et rend les champs
 * fautifs pour qu'ils soient signalés en rouge dans le formulaire.
 */
function describe(err: unknown): { message: string; fields: string[] } {
  const error = err as { code?: number; name?: string; errors?: Record<string, { message: string }> };

  if (error?.code === 11000) {
    return { message: 'Cette entrée existe déjà.', fields: [] };
  }
  if (error?.name === 'ValidationError' && error.errors) {
    return {
      message: Object.values(error.errors).map((e) => e.message).join(' '),
      fields: Object.keys(error.errors)
    };
  }
  return { message: 'Une erreur est survenue. Réessayez.', fields: [] };
}

/**
 * Complète le canton depuis le NPA quand il n'a pas été choisi.
 *
 * Le canton n'est plus demandé dans les formulaires : il découle du NPA, et
 * le faire choisir n'ajoute qu'une occasion de se tromper. Une saisie
 * explicite reste prioritaire — le formulaire d'administration, lui, le pose.
 */
async function withDeducedCanton(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (String(body.canton || '').trim()) {
    return body;
  }

  const completed = await completeAddress(
    String(body.plz || '').trim(),
    String(body.location || '').trim()
  );
  if (!completed.canton) {
    return body;
  }

  return {
    ...body,
    canton: completed.canton,
    location: String(body.location || '').trim() || completed.location
  };
}

// ------------------------------------------------------------------ accueil

router.get('/', async (req: Request, res: Response) => {
  if (await currentUser(req)) {
    return res.redirect('/espace');
  }
  res.type('html').send(views.renderLanding());
});

// --------------------------------------------------------------- connexion

router.get('/connexion', async (req: Request, res: Response) => {
  if (await currentUser(req)) {
    return res.redirect('/espace');
  }
  const notices: Record<string, string> = {
    deconnecte: 'Vous êtes déconnecté.',
    confirme: 'Adresse confirmée : vous pouvez vous connecter.',
    cree: 'Compte créé. Connectez-vous pour accéder à votre espace.'
  };
  res.type('html').send(views.renderLogin({
    csrf: csrfToken(req),
    notice: notices[String(req.query.msg || '')]
  }));
});

router.post('/connexion', async (req: Request, res: Response) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const fail = (error: string, status = 401) =>
    res.status(status).type('html').send(
      views.renderLogin({ csrf: csrfToken(req), email, error })
    );

  try {
    const user = await User.findOne({ email }).select('+password +salt');
    if (!user || !await verifyPassword(password, user.salt, user.password)) {
      // Message unique : ne pas révéler quels emails ont un compte.
      return fail('Email ou mot de passe incorrect.');
    }
    if (user.blocked) {
      return fail('Ce compte est bloqué. Contactez-nous.', 403);
    }
    // Barrière levée quand la confirmation n'est pas exigée (cf. config/features).
    if (emailConfirmationRequired() && !user.emailVerified) {
      return fail('Confirmez votre adresse email avant de vous connecter. Le lien vous a été ' +
        'envoyé lors de votre inscription — pensez à regarder dans vos courriers indésirables.', 403);
    }

    // Régénérer la session à la connexion coupe court à toute fixation de session.
    req.session.regenerate((err) => {
      if (err) {
        console.error('Erreur de session:', err);
        return fail('Erreur serveur. Réessayez.', 500);
      }
      req.session.siteUserUid = user.uid;
      user.lastLoginDate = new Date();
      user.save()
        .then(() => res.redirect('/espace'))
        .catch(() => res.redirect('/espace'));
    });
  } catch (err) {
    console.error('Erreur de connexion:', err);
    fail('Erreur serveur. Réessayez.', 500);
  }
});

router.get('/deconnexion', (req: Request, res: Response) => {
  req.session.destroy(() => res.redirect('/connexion?msg=deconnecte'));
});

// ----------------------------------------------------------------- adresses
//
// Servies au formulaire d'inscription, donc sans authentification : elles ne
// font que relayer un registre public, sans rien révéler du compte. La mise
// en cache du service évite d'en faire un robinet vers swisstopo.

router.get('/adresses', async (req: Request, res: Response) => {
  const results = await suggestAddresses(String(req.query.q || ''));
  // Sans stockage : les propositions dépendent d'une saisie, pas de l'usager.
  res.set('Cache-Control', 'private, max-age=60').json({ results });
});

router.get('/adresses/npa', async (req: Request, res: Response) => {
  const completed = await completeAddress(
    String(req.query.plz || '').trim(),
    String(req.query.location || '').trim()
  );
  res.set('Cache-Control', 'private, max-age=300').json(completed);
});

// -------------------------------------------------------------- inscription

router.get('/inscription', async (req: Request, res: Response) => {
  if (await currentUser(req)) {
    return res.redirect('/espace');
  }
  res.type('html').send(views.renderRegister({
    csrf: csrfToken(req),
    values: {}
  }));
});

/**
 * L'inscription ne demande que l'email, le mot de passe, le téléphone,
 * l'adresse et le numéro AVS. L'identité — nom, prénom, date de naissance —
 * est réclamée juste après, par lecture d'une pièce d'identité.
 */
const REGISTER_FIELDS = ['accountEmail', 'phone', 'road', 'plz', 'location', 'canton', 'avsNum'];

router.post('/inscription', async (req: Request, res: Response) => {
  const values = fieldValues(req.body, REGISTER_FIELDS);
  const accountEmail = String(req.body.accountEmail || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const fail = (error: string, status = 400, invalidFields: string[] = []) =>
    res.status(status).type('html').send(
      views.renderRegister({ csrf: csrfToken(req), values, error, invalidFields })
    );

  if (!EMAIL_PATTERN.test(accountEmail)) {
    return fail('Adresse email invalide.', 400, ['accountEmail']);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`, 400, ['password']);
  }

  const body = await withDeducedCanton({ ...req.body });

  // L'assuré hérite de l'email du compte : à l'inscription, c'est la même
  // personne, et redemander la même adresse deux fois n'a pas de sens.
  const payload = readClientPayload(body, { email: accountEmail });
  if (payload.error || !payload.values) {
    return fail(payload.error || 'Données incomplètes.', 400,
      payload.field ? [payload.field] : []);
  }

  // Le téléphone est facultatif pour les membres ajoutés ensuite, mais celui
  // du titulaire sert de contact au compte : le modèle ne pouvant pas
  // distinguer les deux cas, la règle est appliquée ici.
  if (!payload.values.phone) {
    return fail(PHONE_REQUIRED_MESSAGE, 400, ['phone']);
  }

  if (await User.exists({ email: accountEmail })) {
    return fail('Un compte existe déjà avec cette adresse.', 409);
  }

  const confirmationRequired = emailConfirmationRequired();

  try {
    const salt = generateSalt();
    const user = new User({ email: accountEmail, salt, password: await hashPassword(password, salt) });

    let token: string | undefined;
    if (confirmationRequired) {
      token = generateToken();
      user.emailTokenHash = hashToken(token);
      user.emailTokenExpiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_MS);
    } else {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
    }
    await user.save();

    // Pas de transaction : si le client échoue, l'utilisateur est retiré pour
    // ne pas laisser un compte orphelin qui bloquerait une nouvelle tentative.
    try {
      await Client.create({ ...payload.values, userUid: user.uid });
    } catch (clientErr) {
      await User.deleteOne({ uid: user.uid });
      throw clientErr;
    }

    if (token) {
      const emailSent = await sendConfirmationEmail(user.email, token, resolveBaseUrl(req));
      return res.type('html').send(views.renderRegistered(user.email, emailSent));
    }

    // Sans confirmation à faire, retourner l'utilisateur à la page de connexion
    // pour retaper son mot de passe n'aurait aucun sens : on ouvre la session.
    req.session.regenerate((err) => {
      if (err) {
        console.error('Erreur de session après inscription:', err);
        return res.redirect('/connexion?msg=cree');
      }
      req.session.siteUserUid = user.uid;
      user.lastLoginDate = new Date();
      // Enchaîner sur la pièce d'identité : c'est le moment où l'assuré est
      // encore engagé, et il ne reste qu'une photo à prendre.
      user.save()
        .then(() => res.redirect('/espace/identite'))
        .catch(() => res.redirect('/espace/identite'));
    });
  } catch (err) {
    console.error('Erreur d\'inscription (site):', err);
    { const d = describe(err); fail(d.message, 400, d.fields); }
  }
});

// ------------------------------------------------------------------ espace

router.use('/espace', requireSiteUser);

router.get('/espace', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  try {
    const [clients, insurances] = await Promise.all([
      Client.find({ userUid: user.uid }).sort({ birthdate: 1 }),
      Insurance.find({ userUid: user.uid })
    ]);

    const monthlyTotal = insurances.reduce(
      (sum, i) => sum + monthlyPremium(i.premiumAmount, i.premiumFrequency), 0
    );

    // Prochaine échéance de résiliation encore à venir.
    const now = Date.now();
    const upcoming = insurances
      .filter((i) => i.status === 'ACTIVE')
      .flatMap((insurance) => {
        const deadline = cancellationDeadline(insurance);
        return deadline && deadline.getTime() >= now ? [{ insurance, deadline }] : [];
      })
      .sort((a, b) => a.deadline.getTime() - b.deadline.getTime())[0];

    let savings: { monthly: number; yearly: number } | null = null;
    if (insurances.some((i) => i.type === 'LAMAL' && i.status === 'ACTIVE')) {
      try {
        const context = await buildHouseholdContext(user.uid);
        const result = await optimiseLamal(context);
        savings = result ? result.potentialSavings : null;
      } catch {
        // Une comparaison impossible ne doit pas empêcher l'accueil de s'afficher.
        savings = null;
      }
    }

    res.type('html').send(views.renderDashboard({
      email: user.email,
      clients,
      insurances,
      monthlyTotal: Math.round(monthlyTotal * 100) / 100,
      nextDeadline: upcoming
        ? {
            insurance: upcoming.insurance,
            deadline: upcoming.deadline,
            daysLeft: Math.round((upcoming.deadline.getTime() - now) / 86400000)
          }
        : undefined,
      savings,
      incomplete: clients.filter((client) => !client.birthdate),
      notice: ({
        ok: 'Modifications enregistrées.',
        identite: 'Identité enregistrée.',
        bienvenue: 'Bienvenue ! Votre compte est prêt : commencez par ajouter votre assurance de base.'
      } as Record<string, string>)[String(req.query.msg || '')]
    }));
  } catch (err) {
    console.error('Erreur du tableau de bord:', err);
    res.status(500).type('html').send('Erreur serveur.');
  }
});

// ----------------------------------------------------------------- assurés

router.get('/espace/assures', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const clients = await Client.find({ userUid: user.uid }).sort({ birthdate: 1 });
  const counts = await Insurance.aggregate<{ _id: string; n: number }>([
    { $match: { userUid: user.uid } },
    { $group: { _id: '$clientUid', n: { $sum: 1 } } }
  ]);

  const documents = await documentsByClient(clients.map((c) => c.uid));

  res.type('html').send(views.renderClients({
    email: user.email,
    clients,
    insuranceCount: new Map(counts.map((c) => [c._id, c.n])),
    documentCount: new Map([...documents].map(([uid, list]) => [uid, list.length])),
    notice: ({
      ok: 'Assuré enregistré.',
      identite: 'Identité enregistrée.',
      supprimee: 'Pièce supprimée.'
    } as Record<string, string>)[String(req.query.msg || '')]
  }));
});

/**
 * Adresse déjà connue du foyer : les membres d'une même famille vivent en
 * général sous le même toit, autant ne pas la faire ressaisir.
 */
async function householdAddress(userUid: string) {
  const reference = await Client.findOne({ userUid }).sort({ birthdate: 1 });
  if (!reference) {
    return undefined;
  }
  return {
    label: describeClient(reference),
    road: reference.road,
    plz: reference.plz,
    location: reference.location,
    canton: reference.canton
  };
}

// -------------------------------------------------------- pièce d'identité
//
// L'inscription se limite au contact et à l'adresse. L'identité est renseignée
// ici, par lecture de la pièce déposée.
//
// Les deux faces sont **conservées**, chiffrées : une lettre de résiliation ou
// d'affiliation doit être accompagnée d'une copie de la pièce, faute de quoi la
// caisse la refuse. Ce n'est donc plus une analyse jetable, et le coffre
// (document-vault.service) porte les précautions correspondantes.
//
// Les routes sont écrites pour un assuré quelconque du foyer ; /espace/identite
// n'est qu'un raccourci vers celle du titulaire.

const IDENTITY_FIELDS = ['firstname', 'name', 'birthdate', 'sexe', 'nationality'];

/** Fiche du titulaire du compte : la plus ancienne, donc la première créée. */
async function accountHolder(userUid: string): Promise<IClient | null> {
  return Client.findOne({ userUid }).sort({ _id: 1 });
}

function identityValues(client: IClient): Values {
  return {
    firstname: client.firstname || '',
    name: client.name || '',
    birthdate: client.birthdate ? client.birthdate.toISOString().slice(0, 10) : '',
    sexe: client.sexe || '',
    nationality: client.nationality || ''
  };
}

function storedSides(documents: IIdentityDocument[]): StoredSide[] {
  return documents.map((d) => ({
    side: d.kind as 'RECTO' | 'VERSO',
    filename: d.filename,
    size: d.size,
    uploadedAt: d.uploadedAt
  }));
}

/**
 * Assuré visé par la route, et le fait qu'il s'agisse ou non du titulaire.
 *
 * Le filtre porte toujours le userUid : la pièce d'identité d'un autre foyer
 * doit être introuvable, pas seulement interdite.
 */
async function identityTarget(
  req: Request
): Promise<{ client: IClient; isHolder: boolean } | null> {
  const user = req.siteUser!;
  const uid = req.params.uid;

  if (!uid) {
    const client = await accountHolder(user.uid);
    return client ? { client, isHolder: true } : null;
  }

  const client = await Client.findOne({ uid, userUid: user.uid });
  if (!client) {
    return null;
  }
  const holder = await accountHolder(user.uid);
  return { client, isHolder: holder?.uid === client.uid };
}

/** Face demandée dans l'URL, refusée si elle n'existe pas. */
function readSide(value: string): 'RECTO' | 'VERSO' | null {
  const side = String(value || '').toUpperCase();
  return (IDENTITY_KINDS as readonly string[]).includes(side)
    ? (side as 'RECTO' | 'VERSO')
    : null;
}

async function renderIdentityPage(
  req: Request,
  res: Response,
  target: { client: IClient; isHolder: boolean },
  extra: {
    values?: Values;
    error?: string;
    info?: string;
    warnings?: string[];
    invalidFields?: string[];
    status?: number;
  } = {}
) {
  const user = req.siteUser!;
  const documents = await listDocuments(target.client.uid);

  res.status(extra.status ?? 200).type('html').send(views.renderIdentity({
    email: user.email,
    csrf: csrfToken(req),
    values: extra.values ?? identityValues(target.client),
    clientUid: target.isHolder ? undefined : target.client.uid,
    clientLabel: target.isHolder ? undefined : describeClient(target.client),
    stored: storedSides(documents),
    fresh: target.isHolder && !target.client.birthdate,
    error: extra.error,
    info: extra.info ?? (String(req.query.msg || '') === 'supprimee'
      ? 'Pièce supprimée.'
      : undefined),
    warnings: extra.warnings,
    invalidFields: extra.invalidFields
  }));
}

/** Affichage : titulaire par défaut, ou un membre du foyer désigné. */
async function showIdentity(req: Request, res: Response) {
  const target = await identityTarget(req);
  if (!target) {
    return res.redirect(req.params.uid ? '/espace/assures' : '/espace/assures/nouveau');
  }
  await renderIdentityPage(req, res, target);
}

/**
 * Dépôt d'une face : elle est chiffrée et conservée, puis soumise à la
 * reconnaissance de texte pour pré-remplir l'identité.
 *
 * L'ordre importe : le document est enregistré **avant** l'analyse. Une
 * reconnaissance qui échoue ne doit pas faire perdre la photo, souvent la
 * partie la plus pénible à refaire.
 */
async function depositIdentityDocument(req: Request, res: Response) {
  const user = req.siteUser!;
  const target = await identityTarget(req);

  if (!target) {
    if (req.file) {
      await unlink(req.file.path).catch(() => undefined);
    }
    return res.redirect(req.params.uid ? '/espace/assures' : '/espace/assures/nouveau');
  }

  const side = readSide(String(req.body?.side || ''));
  const file = req.file;

  try {
    if (!side) {
      return await renderIdentityPage(req, res, target, {
        error: 'Face inconnue : indiquez le recto ou le verso.', status: 400
      });
    }
    if (!file) {
      return await renderIdentityPage(req, res, target, {
        error: `Aucun fichier reçu pour le ${KIND_LABELS[side]}.`, status: 400
      });
    }
    if (!isAcceptedDocument(file.mimetype, file.originalname)) {
      return await renderIdentityPage(req, res, target, {
        error: 'Format non pris en charge : déposez une photo (JPEG, PNG) ou un PDF.',
        status: 400
      });
    }

    const stored = await storeDocument({
      userUid: user.uid,
      clientUid: target.client.uid,
      kind: side,
      path: file.path,
      filename: file.originalname,
      mimetype: file.mimetype
    });

    // La reconnaissance ne porte que sur ce qui vient d'être déposé. Le verso
    // porte la bande MRZ, donc l'essentiel ; le recto n'apporte souvent qu'une
    // confirmation, mais rien n'oblige l'assuré à respecter l'ordre.
    const values = identityValues(target.client);
    const warnings: string[] = [];
    let info = stored.replaced
      ? `Le ${KIND_LABELS[side]} a remplacé la pièce précédente.`
      : `Le ${KIND_LABELS[side]} est enregistré.`;

    try {
      const result = await extractFromDocument(file.path, file.mimetype, file.originalname);
      // Ce qui est lu prime sur les valeurs déjà en base : l'assuré vient
      // précisément de fournir la pièce pour les corriger.
      let recognised = false;
      for (const key of IDENTITY_FIELDS) {
        const field = (result.fields as Record<string, { value: string } | undefined>)[key];
        if (field) {
          values[key] = field.value;
          recognised = true;
        }
      }
      warnings.push(...result.warnings);
      info += recognised
        ? ` ${describeExtraction(result)}`
        : ' Aucune donnée n\'a pu en être lue : la bande de caractères figure au verso. ' +
          'Vous pouvez aussi saisir les champs à la main.';
    } catch (err) {
      // Le document est conservé quand même : c'est le but premier du dépôt.
      warnings.push(
        `La pièce est enregistrée, mais n'a pas pu être analysée (${(err as Error).message})`
      );
    }

    await renderIdentityPage(req, res, target, { values, info, warnings });
  } catch (err) {
    console.error('Erreur de dépôt de pièce d\'identité:', err);
    await renderIdentityPage(req, res, target, {
      error: err instanceof VaultError
        ? err.message
        : 'La pièce n\'a pas pu être enregistrée. Réessayez.',
      status: 400
    });
  } finally {
    if (file) {
      await unlink(file.path).catch(() => undefined);
    }
  }
}

/**
 * Restitution d'une pièce à son propriétaire.
 *
 * Jamais mise en cache : une copie dans le cache du navigateur ou d'un proxy
 * intermédiaire survivrait à la déconnexion.
 */
async function serveIdentityDocument(req: Request, res: Response) {
  const user = req.siteUser!;
  const target = await identityTarget(req);
  const side = readSide(req.params.side);

  if (!target || !side) {
    return res.status(404).type('text/plain').send('Pièce introuvable.');
  }

  try {
    const document = await retrieveDocument(
      target.client.uid, side, `assuré ${user.uid}`
    );
    if (!document) {
      return res.status(404).type('text/plain').send('Pièce introuvable.');
    }

    res.set({
      'Content-Type': document.mimetype,
      'Content-Disposition': `inline; filename="${side.toLowerCase()}"`,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      // Une pièce d'identité n'a rien à faire dans le cadre d'une autre page.
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; frame-ancestors 'none'"
    }).send(document.content);
  } catch (err) {
    res.status(500).type('text/plain').send((err as Error).message);
  }
}

async function removeIdentityDocument(req: Request, res: Response) {
  const target = await identityTarget(req);
  const side = readSide(req.params.side);

  if (!target || !side) {
    return res.redirect('/espace/assures');
  }

  await deleteDocument(target.client.uid, side);
  res.redirect(target.isHolder
    ? '/espace/identite?msg=supprimee'
    : `/espace/assures/${target.client.uid}/piece?msg=supprimee`);
}

/** Enregistrement de l'identité relue par l'assuré. */
async function saveIdentity(req: Request, res: Response) {
  const target = await identityTarget(req);
  if (!target) {
    return res.redirect(req.params.uid ? '/espace/assures' : '/espace/assures/nouveau');
  }

  const client = target.client;
  const values = fieldValues(req.body, IDENTITY_FIELDS);
  const fail = (error: string, invalidFields: string[] = []) =>
    renderIdentityPage(req, res, target, { values, error, invalidFields, status: 400 });

  const rawBirthdate = String(values.birthdate || '');
  if (rawBirthdate) {
    const birthdate = new Date(rawBirthdate);
    if (Number.isNaN(birthdate.getTime())) {
      return fail('La date de naissance est invalide.', ['birthdate']);
    }
    if (birthdate.getTime() > Date.now()) {
      return fail('La date de naissance ne peut pas être dans le futur.', ['birthdate']);
    }
    client.birthdate = birthdate;
  } else {
    client.birthdate = undefined;
  }

  // Un champ vidé est retiré plutôt qu'enregistré à '' : une chaîne vide
  // échouerait sur l'énumération du sexe, et ferait passer une fiche
  // incomplète pour une fiche remplie.
  client.firstname = String(values.firstname || '') || undefined;
  client.name = String(values.name || '') || undefined;
  client.sexe = (String(values.sexe || '') || undefined) as IClient['sexe'];
  client.nationality = String(values.nationality || '') || undefined;

  try {
    await client.save();
    res.redirect(target.isHolder ? '/espace?msg=identite' : '/espace/assures?msg=identite');
  } catch (err) {
    console.error('Erreur d\'enregistrement de l\'identité (site):', err);
    const d = describe(err);
    fail(d.message, d.fields);
  }
}

// Titulaire du compte.
router.get('/espace/identite', showIdentity);
router.post('/espace/identite/deposer', upload.single('document'), verifyUploadCsrf,
  depositIdentityDocument);
router.get('/espace/identite/:side(recto|verso)', serveIdentityDocument);
router.post('/espace/identite/:side(recto|verso)/supprimer', removeIdentityDocument);
router.post('/espace/identite', saveIdentity);

// N'importe quel assuré du foyer : conjoint, enfant.
router.get('/espace/assures/:uid/piece', showIdentity);
router.post('/espace/assures/:uid/piece/deposer', upload.single('document'), verifyUploadCsrf,
  depositIdentityDocument);
router.get('/espace/assures/:uid/piece/:side(recto|verso)', serveIdentityDocument);
router.post('/espace/assures/:uid/piece/:side(recto|verso)/supprimer', removeIdentityDocument);
router.post('/espace/assures/:uid/piece', saveIdentity);

router.get('/espace/assures/nouveau', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const address = await householdAddress(user.uid);
  const requirePhone = await isFirstClientOfHousehold(user.uid);

  res.type('html').send(views.renderClientForm({
    email: user.email,
    csrf: csrfToken(req),
    // Pré-remplie côté serveur : le formulaire reste juste sans JavaScript.
    values: {
      nationality: 'CH',
      email: user.email,
      road: address?.road,
      plz: address?.plz,
      location: address?.location,
      canton: address?.canton
    },
    householdAddress: address,
    requirePhone
  }));
});

router.post('/espace/assures/nouveau', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const values = fieldValues(req.body, CLIENT_FIELDS);

  const fail = (error: string, status = 400, invalidFields: string[] = []) =>
    res.status(status).type('html').send(
      views.renderClientForm({
        email: user.email, csrf: csrfToken(req), values, error, invalidFields
      })
    );

  const payload = readClientPayload(await withDeducedCanton({ ...req.body }), { email: user.email });
  if (payload.error || !payload.values) {
    return fail(payload.error || 'Données incomplètes.', 400, payload.field ? [payload.field] : []);
  }

  try {
    if (await Client.countDocuments({ userUid: user.uid }) >= MAX_CLIENTS_PER_USER) {
      return fail(`Un compte ne peut pas dépasser ${MAX_CLIENTS_PER_USER} assurés.`, 409);
    }
    if (!payload.values.phone && await isFirstClientOfHousehold(user.uid)) {
      return fail(PHONE_REQUIRED_MESSAGE, 400, ['phone']);
    }
    await Client.create({ ...payload.values, userUid: user.uid });
    res.redirect('/espace/assures?msg=ok');
  } catch (err) {
    console.error('Erreur de création d\'assuré (site):', err);
    { const d = describe(err); fail(d.message, 400, d.fields); }
  }
});

/**
 * Analyse un document et réaffiche le formulaire d'assuré pré-rempli.
 * Rien n'est enregistré : l'assuré relit puis valide.
 */
router.post('/espace/assures/importer', upload.single('document'), verifyUploadCsrf,
  async (req: Request, res: Response) => {
    const user = req.siteUser!;
    const address = await householdAddress(user.uid);
    const render = (values: Values, extra: { error?: string; info?: string; warnings?: string[] } = {}) =>
      res.type('html').send(views.renderClientForm({
        email: user.email, csrf: csrfToken(req), values, householdAddress: address, ...extra
      }));

    // L'adresse du foyer sert de point de départ ; le document la remplace
    // s'il en porte une, et la case se décoche alors d'elle-même.
    const base: Values = {
      nationality: 'CH',
      email: user.email,
      road: address?.road,
      plz: address?.plz,
      location: address?.location,
      canton: address?.canton
    };
    const file = req.file;
    if (!file) {
      return render(base, { error: 'Aucun fichier reçu.' });
    }

    try {
      if (!isSupportedDocument(file.mimetype, file.originalname)) {
        return render(base, { error: 'Format non pris en charge : déposez une photo ou un PDF.' });
      }
      const result = await extractFromDocument(file.path, file.mimetype, file.originalname);
      render(applyToClient(base, result), {
        info: describeExtraction(result),
        warnings: result.warnings
      });
    } catch (err) {
      render(base, { error: (err as Error).message });
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  });

router.get('/espace/assures/:uid/modifier', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const client = await Client.findOne({ uid: req.params.uid, userUid: user.uid });
  if (!client) {
    return res.status(404).redirect('/espace/assures');
  }
  res.type('html').send(views.renderClientForm({
    email: user.email,
    csrf: csrfToken(req),
    uid: client.uid,
    values: views.clientToValues(client)
  }));
});

router.post('/espace/assures/:uid/modifier', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const values = fieldValues(req.body, CLIENT_FIELDS);

  const fail = (error: string, status = 400, invalidFields: string[] = []) =>
    res.status(status).type('html').send(views.renderClientForm({
      email: user.email, csrf: csrfToken(req), uid: req.params.uid, values, error, invalidFields
    }));

  const payload = readClientPayload(await withDeducedCanton({ ...req.body }), { email: user.email });
  if (payload.error || !payload.values) {
    return fail(payload.error || 'Données incomplètes.', 400, payload.field ? [payload.field] : []);
  }

  // Un champ facultatif vidé doit disparaître de la fiche. Mongo ignore
  // purement et simplement les clés à undefined dans un $set : sans $unset
  // explicite, effacer un prénom ne ferait rien du tout.
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  for (const [key, value] of Object.entries(payload.values)) {
    if (value === undefined) {
      unset[key] = '';
    } else {
      set[key] = value;
    }
  }

  try {
    // Le filtre porte le userUid : un assuré d'un autre foyer est introuvable.
    const result = await Client.findOneAndUpdate(
      { uid: req.params.uid, userUid: user.uid },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true, runValidators: true }
    );
    if (!result) {
      return res.status(404).redirect('/espace/assures');
    }
    res.redirect('/espace/assures?msg=ok');
  } catch (err) {
    console.error('Erreur de modification d\'assuré (site):', err);
    { const d = describe(err); fail(d.message, 400, d.fields); }
  }
});

// -------------------------------------------------------------- assurances

/**
 * Assuré retenu d'office quand le foyer n'en compte qu'un.
 *
 * Le calcul de la prime dépend de l'assuré — c'est son âge qui fixe le tarif.
 * Laisser le champ vide dans un foyer d'une personne bloquait l'affichage de
 * la prime sans qu'aucun choix ne reste à faire.
 */
function onlyInsured(options: Array<[string, string]>): string | undefined {
  return options.length === 1 ? options[0][0] : undefined;
}

/** Normalisation pour comparer des noms : sans accents, ni casse, ni ponctuation. */
function nameKey(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Retrouve l'assuré désigné par une police, par son nom ou sa date de naissance.
 *
 * Beaucoup de polices ne portent aucun numéro AVS — celle de Sanitas n'en a
 * pas — mais toutes nomment la personne assurée. Le nom suffit dans un foyer,
 * où l'on ne compte pas deux homonymes ; la date de naissance sert d'appoint
 * quand la reconnaissance de texte a abîmé l'orthographe.
 */
async function matchInsured(
  userUid: string,
  name?: string,
  birthdate?: string
): Promise<IClient | null> {
  const clients = await Client.find({ userUid });
  if (!clients.length) {
    return null;
  }

  if (name) {
    const wanted = nameKey(name);
    const parts = wanted.split(' ').filter((part) => part.length >= 3);

    // Le nom complet d'abord, dans les deux ordres : les polices écrivent
    // aussi bien « Sara Chalokh » que « Chalokh Sara ».
    const exact = clients.find((client) => {
      const full = nameKey([client.firstname, client.name].filter(Boolean).join(' '));
      const reversed = nameKey([client.name, client.firstname].filter(Boolean).join(' '));
      return full === wanted || reversed === wanted;
    });
    if (exact) {
      return exact;
    }

    // À défaut, tous les mots significatifs du nom de l'assuré doivent
    // apparaître : « Sara Caroline Chalokh » reconnaît « Sara Chalokh ».
    const partial = clients.filter((client) => {
      const full = ` ${nameKey([client.firstname, client.name].filter(Boolean).join(' '))} `;
      return parts.length > 0 && parts.every((part) => full.includes(` ${part} `));
    });
    if (partial.length === 1) {
      return partial[0];
    }
  }

  // Dernier recours : la date de naissance, si elle ne désigne qu'une personne.
  if (birthdate) {
    const day = new Date(birthdate);
    const sameDay = clients.filter((client) => client.birthdate &&
      client.birthdate.toISOString().slice(0, 10) === day.toISOString().slice(0, 10));
    if (sameDay.length === 1) {
      return sameDay[0];
    }
  }

  return null;
}

async function insuredOptions(userUid: string): Promise<Array<[string, string]>> {
  const clients = await Client.find({ userUid }).sort({ birthdate: 1 });
  return clients.map((c) => [c.uid, describeClient(c)] as [string, string]);
}

/**
 * Catalogue officiel de la région du foyer, pour alimenter les listes de choix
 * du formulaire LAMal. Son absence n'est pas une erreur : sans tarifs importés,
 * ou pour un NPA hors des régions connues, le formulaire retombe sur la saisie
 * libre plutôt que d'empêcher d'enregistrer un contrat.
 */
async function householdCatalogue(userUid: string): Promise<Catalogue | undefined> {
  try {
    const reference = await Client.findOne({ userUid }).sort({ birthdate: 1 });
    if (!reference) {
      return undefined;
    }
    return (await catalogueFor(reference.plz, reference.location)) ?? undefined;
  } catch (err) {
    console.error('Catalogue LAMal indisponible:', err);
    return undefined;
  }
}

/**
 * Complète le corps du formulaire LAMal à partir du catalogue.
 *
 * L'assuré ne choisit qu'une caisse, un modèle et une franchise ; tout le reste
 * — nom commercial, famille de modèle, identifiant de caisse et surtout la
 * prime — est repris du tarif officiel. C'est ce qui garantit que le contrat
 * enregistré et la comparaison parlent des mêmes chiffres : une prime recopiée
 * à la main est la première source d'écart entre les deux.
 */
async function applyLamalCatalogue(
  body: Record<string, unknown>,
  client: IClient,
  catalogue?: Catalogue
): Promise<{ error?: string; field?: string }> {
  if (String(body.type ?? '').toUpperCase() !== 'LAMAL' || !catalogue) {
    return {};
  }

  const insurerId = Number.parseInt(String(body.lamalInsurerId ?? ''), 10);
  const tariffCode = String(body.lamalTariffCode ?? '').trim();
  if (!Number.isFinite(insurerId)) {
    return { error: 'Choisissez votre caisse maladie.', field: 'lamalInsurerId' };
  }
  if (!tariffCode) {
    return { error: 'Choisissez votre modèle d\'assurance.', field: 'lamalTariffCode' };
  }

  const insurer = catalogue.insurers.find((i) => i.insurerId === insurerId);
  const tariff = insurer?.tariffs.find((t) => t.tariffCode === tariffCode);
  if (!insurer || !tariff) {
    return {
      error: 'Ce modèle n\'est pas proposé par cette caisse dans votre région.',
      field: 'lamalTariffCode'
    };
  }

  // La franchise saisie est ramenée à une valeur légale pour l'âge : les
  // listes affichent toutes les franchises, adultes et enfants confondus.
  // Sans date de naissance, impossible de savoir si la franchise enfant
  // s'applique : on la demande ici plutôt que d'en choisir une au hasard.
  if (!client.birthdate) {
    return {
      error: 'Ajoutez d\'abord la date de naissance de cet assuré : elle détermine la franchise et la prime.',
      field: 'franchise'
    };
  }
  const age = ageAt(client.birthdate, new Date());
  const requested = Number.parseInt(String(body.franchise ?? ''), 10);
  if (!Number.isFinite(requested)) {
    return { error: 'Choisissez une franchise.', field: 'franchise' };
  }
  const franchise = nearestLegalFranchise(requested, age < 19);

  body.provider = insurer.name;
  body.productName = tariff.label;
  body.tariffCode = tariff.tariffCode;
  body.tariffType = tariff.tariffType;
  body.franchise = franchise;

  const premium = await premiumFor({
    year: catalogue.year,
    canton: catalogue.location.canton,
    region: catalogue.location.region,
    insurerId,
    tariffCode,
    age,
    franchise,
    withAccident: body.employerAccidentCoverage !== true
  });

  if (premium === null) {
    return {
      error: `Aucun tarif officiel ${catalogue.year} pour ce modèle avec une franchise de ` +
        `${franchise} francs. Choisissez une autre franchise ou un autre modèle.`,
      field: 'franchise'
    };
  }

  // Les primes LAMal sont publiées au mois : les enregistrer autrement
  // obligerait à convertir, donc à réintroduire une source d'écart.
  body.premiumAmount = premium;
  body.premiumFrequency = 'MENSUEL';
  return {};
}

router.get('/espace/assurances', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const [insurances, clients] = await Promise.all([
    Insurance.find({ userUid: user.uid }).sort({ type: 1, provider: 1 }),
    Client.find({ userUid: user.uid })
  ]);

  const monthlyTotal = insurances.reduce(
    (sum, i) => sum + monthlyPremium(i.premiumAmount, i.premiumFrequency), 0
  );

  const notices: Record<string, string> = {
    ok: 'Contrat enregistré.',
    supprime: 'Contrat supprimé.'
  };

  // L'économie atteignable est mise en avant sur cette page : c'est là que
  // l'assuré regarde ce qu'il paie, donc là que la comparaison a du sens.
  const hasLamal = insurances.some((i) => i.type === 'LAMAL' && i.status === 'ACTIVE');
  const savings = hasLamal ? (await currentSavings(user.uid)).savings : null;

  res.type('html').send(views.renderInsurances({
    email: user.email,
    insurances,
    clients: new Map(clients.map((c) => [c.uid, c as IClient])),
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
    csrf: csrfToken(req),
    notice: notices[String(req.query.msg || '')],
    savings,
    hasLamal
  }));
});

router.get('/espace/assurances/nouvelle', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const insured = await insuredOptions(user.uid);

  res.type('html').send(views.renderInsuranceForm({
    email: user.email,
    csrf: csrfToken(req),
    values: {
      type: 'LAMAL',
      status: 'ACTIVE',
      premiumFrequency: 'MENSUEL',
      autoRenew: true,
      clientUid: String(req.query.assure || '') || onlyInsured(insured)
    },
    insuredOptions: insured,
    catalogue: await householdCatalogue(user.uid)
  }));
});

router.post('/espace/assurances/nouvelle', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const values = fieldValues(req.body, INSURANCE_FIELDS);
  values.autoRenew = req.body.autoRenew === 'true';
  values.employerAccidentCoverage = req.body.employerAccidentCoverage === 'true';

  const fail = async (error: string, status = 400, invalidFields: string[] = []) =>
    res.status(status).type('html').send(views.renderInsuranceForm({
      email: user.email,
      csrf: csrfToken(req),
      values,
      insuredOptions: await insuredOptions(user.uid),
      catalogue: await householdCatalogue(user.uid),
      error,
      invalidFields
    }));

  try {
    const client = await Client.findOne({ uid: String(req.body.clientUid || ''), userUid: user.uid });
    if (!client) {
      return fail('Cet assuré n\'appartient pas à votre foyer.', 404);
    }

    // Caisse, modèle, franchise et prime sont repris du catalogue officiel
    // avant toute lecture : le formulaire ne transmet que les choix.
    const body = {
      ...req.body,
      autoRenew: req.body.autoRenew === 'true',
      employerAccidentCoverage: req.body.employerAccidentCoverage === 'true'
    } as Record<string, unknown>;

    const derived = await applyLamalCatalogue(body, client, await householdCatalogue(user.uid));
    if (derived.error) {
      return fail(derived.error, 400, derived.field ? [derived.field] : []);
    }

    const payload = readInsurancePayload(body);
    if (payload.error || !payload.values) {
      return fail(payload.error || 'Données incomplètes.');
    }

    if (await Insurance.countDocuments({ userUid: user.uid }) >= MAX_INSURANCES_PER_USER) {
      return fail(`Un compte ne peut pas dépasser ${MAX_INSURANCES_PER_USER} contrats.`, 409);
    }

    await Insurance.create({
      ...payload.values,
      insurerId: Number.parseInt(String(body.lamalInsurerId ?? ''), 10) || undefined,
      userUid: user.uid
    });
    res.redirect('/espace/assurances?msg=ok');
  } catch (err) {
    console.error('Erreur de création de contrat (site):', err);
    { const d = describe(err); fail(d.message, 400, d.fields); }
  }
});

/**
 * Dépôt d'une police : fichier → reconnaissance optique → modèle de langage →
 * formulaire pré-rempli.
 *
 * La reconnaissance optique rend un texte brut et désordonné ; c'est le modèle
 * local qui en tire une caisse, un modèle d'assurance, une franchise et une
 * prime. Sa réponse est ensuite confrontée au catalogue officiel : rien de ce
 * qu'il invente ne parvient jusqu'au formulaire.
 *
 * Trois filets successifs, du plus précis au plus fruste :
 *   1. le modèle de langage, validé contre le catalogue de la région ;
 *   2. les motifs textuels, pour le n° de police et le n° AVS ;
 *   3. la saisie manuelle, toujours disponible.
 */
router.post('/espace/assurances/importer', upload.single('document'), verifyUploadCsrf,
  async (req: Request, res: Response) => {
    const user = req.siteUser!;
    const base: Values = {
      type: 'LAMAL', status: 'ACTIVE', premiumFrequency: 'MENSUEL', autoRenew: true
    };

    // Le catalogue doit accompagner **tous** les rendus : sans lui, le
    // formulaire retombe sur la saisie libre et l'assuré perd les listes de
    // caisses et de modèles qu'il avait sous les yeux une seconde plus tôt.
    const catalogue = await householdCatalogue(user.uid);

    const render = async (values: Values, extra: { error?: string; info?: string; warnings?: string[] } = {}) =>
      res.type('html').send(views.renderInsuranceForm({
        email: user.email,
        csrf: csrfToken(req),
        values,
        insuredOptions: await insuredOptions(user.uid),
        catalogue,
        ...extra
      }));

    const file = req.file;
    if (!file) {
      return render(base, { error: 'Aucun fichier reçu.' });
    }

    try {
      if (!isSupportedDocument(file.mimetype, file.originalname)) {
        return render(base, { error: 'Format non pris en charge : déposez une photo ou un PDF.' });
      }

      const result = await extractFromDocument(file.path, file.mimetype, file.originalname);
      const values = applyToInsurance(base, result);
      const warnings = [...result.warnings];
      const recognised: string[] = [];

      // Ce que les motifs textuels ont déjà trouvé compte dans le résumé : le
      // n° AVS a un format strict, donc fiable, et le n° de police est repéré
      // par son étiquette. Les annoncer évite de dire « rien n'a été lu » sur
      // un formulaire où deux champs sont pourtant remplis.
      let avsNum = result.fields.avsNum?.value;
      let insuredName: string | undefined;
      let insuredBirthdate: string | undefined;
      if (avsNum) {
        recognised.push('n° AVS');
      }
      if (values.policyNumber) {
        recognised.push('n° de police');
      }

      if (catalogue) {
        // L'âge sert à départager deux modèles d'une même famille par le
        // montant de leur prime. Celui de l'assuré de référence : dans un
        // foyer d'une personne c'est le bon, et ailleurs un âge inexact ne
        // fait qu'empêcher le calcul de tomber juste — jamais de le fausser.
        const reference = await Client.findOne({ userUid: user.uid }).sort({ birthdate: 1 });
        const age = reference?.birthdate ? ageAt(reference.birthdate, new Date()) : undefined;

        const reading = await readPolicy(result.text, catalogue, age);

        if (reading) {
          warnings.push(...reading.warnings);
          recognised.push(...reading.recognised);

          // Les champs du formulaire LAMal ne sont pas ceux du modèle générique :
          // la caisse et l'offre sont choisies dans le catalogue, pas saisies.
          if (reading.insurerId !== undefined) {
            values.lamalInsurerId = String(reading.insurerId);
            values.provider = reading.insurerName;
          }
          if (reading.tariffCode) {
            values.lamalTariffCode = reading.tariffCode;
          }
          if (reading.franchise !== undefined) {
            values.franchise = String(reading.franchise);
          }
          if (reading.premiumAmount !== undefined) {
            values.premiumAmount = String(reading.premiumAmount);
          }
          if (reading.policyNumber) {
            values.policyNumber = reading.policyNumber;
          }
          if (reading.employerAccidentCoverage !== undefined) {
            values.employerAccidentCoverage = reading.employerAccidentCoverage;
          }
          if (reading.startDate) {
            values.startDate = reading.startDate;
          }
          // Les précisions de la police — médecin coordonnateur et son adresse,
          // réseau de soins, intermédiaire — n'ont pas de champ à elles mais
          // sont utiles le jour où il faut résilier ou changer de modèle.
          if (reading.notes) {
            values.description = reading.notes;
          }
          avsNum = avsNum || reading.avsNum;
          insuredName = reading.insuredName;
          insuredBirthdate = reading.insuredBirthdate;
        } else {
          warnings.push(
            'La lecture assistée n\'était pas disponible : seuls les éléments les plus ' +
            'simples ont été repris. Vérifiez la caisse, le modèle et la franchise.'
          );
        }
      } else {
        warnings.push(
          'Les tarifs officiels ne sont pas disponibles pour votre région : la caisse ' +
          'et le modèle doivent être saisis à la main.'
        );
      }

      // Le document désigne souvent une personne : on tente de la retrouver
      // dans le foyer par son numéro AVS, qui est sans ambiguïté.
      const insured = await insuredOptions(user.uid);

      // Rattachement de la police à une personne du foyer, du repère le plus
      // sûr au plus souple : le numéro AVS quand il figure, sinon le nom que
      // toutes les polices portent, sinon la date de naissance.
      if (avsNum) {
        const match = await Client.findOne({ userUid: user.uid, avsNum });
        if (match) {
          values.clientUid = match.uid;
        } else {
          warnings.push(
            `Le numéro AVS ${avsNum} ne correspond à aucun assuré de votre foyer : ` +
            'choisissez la personne concernée.'
          );
        }
      }
      if (!values.clientUid && (insuredName || insuredBirthdate)) {
        const match = await matchInsured(user.uid, insuredName, insuredBirthdate);
        if (match) {
          values.clientUid = match.uid;
          recognised.push('assuré');
        } else if (insuredName) {
          warnings.push(
            `La police est au nom de « ${insuredName} », qui ne correspond à aucun ` +
            'assuré de votre foyer : choisissez la personne concernée.'
          );
        }
      }

      // Beaucoup de polices ne portent aucun numéro AVS : sans ce repli, le
      // champ « assuré » restait vide et la prime ne s'affichait pas, alors
      // qu'aucun choix ne se posait réellement.
      if (!values.clientUid) {
        values.clientUid = onlyInsured(insured);
      }

      await render(values, { info: describePolicyReading(result, recognised), warnings });
    } catch (err) {
      await render(base, { error: (err as Error).message });
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  });

router.get('/espace/assurances/:uid/modifier', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const insurance = await Insurance.findOne({ uid: req.params.uid, userUid: user.uid });
  if (!insurance) {
    return res.status(404).redirect('/espace/assurances');
  }
  res.type('html').send(views.renderInsuranceForm({
    email: user.email,
    csrf: csrfToken(req),
    uid: insurance.uid,
    values: views.insuranceToValues(insurance),
    insuredOptions: await insuredOptions(user.uid),
    catalogue: await householdCatalogue(user.uid)
  }));
});

router.post('/espace/assurances/:uid/modifier', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const values = fieldValues(req.body, INSURANCE_FIELDS);
  values.autoRenew = req.body.autoRenew === 'true';
  values.employerAccidentCoverage = req.body.employerAccidentCoverage === 'true';

  const fail = async (error: string, status = 400, invalidFields: string[] = []) =>
    res.status(status).type('html').send(views.renderInsuranceForm({
      email: user.email,
      csrf: csrfToken(req),
      uid: req.params.uid,
      values,
      insuredOptions: await insuredOptions(user.uid),
      catalogue: await householdCatalogue(user.uid),
      error,
      invalidFields
    }));

  try {
    const client = await Client.findOne({ uid: String(req.body.clientUid || ''), userUid: user.uid });
    if (!client) {
      return fail('Cet assuré n\'appartient pas à votre foyer.', 404);
    }

    const body = {
      ...req.body,
      autoRenew: req.body.autoRenew === 'true',
      employerAccidentCoverage: req.body.employerAccidentCoverage === 'true'
    } as Record<string, unknown>;

    const derived = await applyLamalCatalogue(body, client, await householdCatalogue(user.uid));
    if (derived.error) {
      return fail(derived.error, 400, derived.field ? [derived.field] : []);
    }

    const payload = readInsurancePayload(body);
    if (payload.error || !payload.values) {
      return fail(payload.error || 'Données incomplètes.');
    }

    const insurance = await Insurance.findOne({ uid: req.params.uid, userUid: user.uid });
    if (!insurance) {
      return res.status(404).redirect('/espace/assurances');
    }

    // `payload.values` porte déjà les cases à cocher et les règles LAMal.
    // Les réécrire ici remettrait la reconduction tacite à « non » sur une
    // LAMal, dont la case est masquée puisque la loi l'impose.
    Object.assign(insurance, payload.values);
    const chosenInsurer = Number.parseInt(String(body.lamalInsurerId ?? ''), 10);
    if (Number.isFinite(chosenInsurer)) {
      insurance.insurerId = chosenInsurer;
    }
    await insurance.save();

    res.redirect('/espace/assurances?msg=ok');
  } catch (err) {
    console.error('Erreur de modification de contrat (site):', err);
    { const d = describe(err); fail(d.message, 400, d.fields); }
  }
});

/**
 * Prime officielle d'un modèle, pour l'afficher pendant la saisie.
 *
 * Doublon assumé de `GET /api/comparison/lamal-premium` : le site s'authentifie
 * par cookie de session, l'API mobile par jeton Bearer. Le calcul, lui, n'est
 * pas dupliqué — les deux passent par le même service.
 */
router.get('/espace/assurances/lamal/prime', async (req: Request, res: Response) => {
  const user = req.siteUser!;

  try {
    const client = await Client.findOne({
      uid: String(req.query.clientUid || ''),
      userUid: user.uid
    });
    const insurerId = Number.parseInt(String(req.query.insurerId ?? ''), 10);
    const franchise = Number.parseInt(String(req.query.franchise ?? ''), 10);
    const tariffCode = String(req.query.tariffCode || '').trim();

    if (!client || !Number.isFinite(insurerId) || !Number.isFinite(franchise) || !tariffCode) {
      return res.status(400).json({ code: 'INCOMPLETE', message: 'Critères incomplets.' });
    }

    const catalogue = await householdCatalogue(user.uid);
    if (!catalogue) {
      return res.status(404).json({ code: 'NO_PREMIUM_DATA', message: 'Tarifs indisponibles.' });
    }

    if (!client.birthdate) {
      return res.status(400).json({
        code: 'BIRTHDATE_REQUIRED',
        message: 'La date de naissance de cet assuré est nécessaire pour calculer la prime.'
      });
    }

    const age = ageAt(client.birthdate, new Date());
    const premium = await premiumFor({
      year: catalogue.year,
      canton: catalogue.location.canton,
      region: catalogue.location.region,
      insurerId,
      tariffCode,
      age,
      franchise: nearestLegalFranchise(franchise, age < 19),
      // Le paramètre suit la convention de l'OFSP : 1 = accident inclus.
      withAccident: String(req.query.coverage || '1') !== '0'
    });

    if (premium === null) {
      return res.status(404).json({
        code: 'NO_PREMIUM_FOR_CRITERIA',
        message: 'Aucun tarif pour ces critères.'
      });
    }

    res.json({ monthly: premium, yearly: Math.round(premium * 12 * 100) / 100 });
  } catch (err) {
    console.error('Erreur de lecture d\'une prime (site):', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
});

router.post('/espace/assurances/:uid/supprimer', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  await Insurance.deleteOne({ uid: req.params.uid, userUid: user.uid });
  res.redirect('/espace/assurances?msg=supprime');
});

// ------------------------------------------------------------ optimisation

router.get('/espace/optimisation', async (req: Request, res: Response) => {
  const user = req.siteUser!;

  try {
    const context = await buildHouseholdContext(user.uid);
    const result = await optimiseLamal(context);

    if (!result) {
      return res.type('html').send(views.renderOptimisationUnavailable({
        email: user.email,
        title: 'Comparaison indisponible',
        message: 'Les tarifs officiels ne sont pas encore chargés. Réessayez plus tard.'
      }));
    }

    res.type('html').send(views.renderOptimisation({
      email: user.email,
      result,
      limit: OFFERS_SHOWN
    }));
  } catch (err) {
    if (err instanceof HouseholdError) {
      return res.status(err.status).type('html').send(views.renderOptimisationUnavailable({
        email: user.email,
        title: 'Comparaison impossible',
        message: err.message,
        action: err.code === 'CURRENT_LAMAL_REQUIRED'
          ? { href: '/espace/assurances/nouvelle', label: 'Ajouter mon assurance de base' }
          : { href: '/espace/assures', label: 'Vérifier mes assurés' }
      }));
    }
    console.error('Erreur d\'optimisation (site):', err);
    res.status(500).type('html').send('Erreur serveur.');
  }
});

// ------------------------------------------------------------ souscription

/**
 * Économie affichée à l'assuré, reprise telle quelle sur la page de
 * souscription. Une comparaison impossible ne doit pas bloquer le formulaire :
 * le recueil d'avis a de la valeur même sans chiffre à afficher.
 */
async function currentSavings(userUid: string): Promise<{
  savings: { monthly: number; yearly: number } | null;
  strategy?: string;
}> {
  try {
    const result = await optimiseLamal(await buildHouseholdContext(userUid));
    if (!result) {
      return { savings: null };
    }
    const individual = result.individual;
    return individual && individual.extra.monthly > 0
      ? { savings: individual.savings, strategy: 'INDIVIDUAL' }
      : { savings: result.potentialSavings, strategy: 'GROUPED' };
  } catch {
    return { savings: null };
  }
}


// ------------------------------------------------------ changement de caisse
//
// Le service : produire les deux courriers qu'un changement de caisse exige,
// remplis et signés. Ils restent à envoyer par l'assuré, en recommandé — un
// envoi que nous ferions à sa place et qui échouerait ne se verrait qu'en
// janvier, quand plus rien n'est rattrapable.

/**
 * Année visée par le changement.
 *
 * Tant que l'échéance de novembre n'est pas passée, le changement porte sur
 * l'année suivante. Après, il ne peut plus viser que celle d'après : une
 * résiliation reçue en décembre prend effet un an plus tard.
 */
function targetYear(now = new Date()): number {
  const nextYear = now.getFullYear() + 1;
  return now.getTime() <= cancellationDeadlineFor(nextYear).getTime()
    ? nextYear
    : nextYear + 1;
}

/**
 * L'assuré a-t-il répondu au questionnaire ?
 *
 * C'est la condition d'accès aux lettres. Le service est en construction et
 * n'a aucun autre moyen de savoir ce qu'en attendent ceux qui s'en servent :
 * un questionnaire simplement proposé à côté du bouton utile n'aurait jamais
 * été rempli. Il n'est demandé qu'une fois, et les réponses restent
 * modifiables.
 */
async function hasAnsweredSurvey(userUid: string): Promise<boolean> {
  return Boolean(await Feedback.exists({ userUid }));
}

/** Signature du titulaire : une seule pour tout le foyer, demandée une fois. */
async function signatureHolder(userUid: string): Promise<IClient | null> {
  return accountHolder(userUid);
}

router.get('/espace/signature', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const holder = await signatureHolder(user.uid);
  if (!holder) {
    return res.redirect('/espace/assures/nouveau');
  }

  res.type('html').send(views.renderSignature({
    email: user.email,
    csrf: csrfToken(req),
    hasSignature: await hasDocument(holder.uid, 'SIGNATURE'),
    returnTo: '/espace/changement',
    notice: String(req.query.msg || '') === 'ok' ? 'Signature enregistrée.' : undefined
  }));
});

router.post('/espace/signature', upload.single('signature'), verifyUploadCsrf,
  async (req: Request, res: Response) => {
    const user = req.siteUser!;
    const holder = await signatureHolder(user.uid);

    if (!holder) {
      if (req.file) {
        await unlink(req.file.path).catch(() => undefined);
      }
      return res.redirect('/espace/assures/nouveau');
    }

    const file = req.file;
    const fail = async (error: string) =>
      res.status(400).type('html').send(views.renderSignature({
        email: user.email,
        csrf: csrfToken(req),
        hasSignature: await hasDocument(holder.uid, 'SIGNATURE'),
        returnTo: '/espace/changement',
        error
      }));

    try {
      if (!file) {
        return await fail('Aucune signature reçue : tracez-la, ou déposez-en une photo.');
      }
      if (!isAcceptedDocument(file.mimetype, file.originalname)) {
        return await fail('Format non pris en charge : déposez une image.');
      }

      await storeDocument({
        userUid: user.uid,
        clientUid: holder.uid,
        kind: 'SIGNATURE',
        path: file.path,
        filename: file.originalname || 'signature.png',
        mimetype: file.mimetype
      });
      res.redirect('/espace/signature?msg=ok');
    } catch (err) {
      console.error('Erreur d\'enregistrement de la signature:', err);
      await fail(err instanceof VaultError
        ? err.message
        : 'La signature n\'a pas pu être enregistrée. Réessayez.');
    } finally {
      if (file) {
        await unlink(file.path).catch(() => undefined);
      }
    }
  });

router.get('/espace/signature/image', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const holder = await signatureHolder(user.uid);
  if (!holder) {
    return res.status(404).type('text/plain').send('Signature introuvable.');
  }

  try {
    const document = await retrieveDocument(holder.uid, 'SIGNATURE', `assuré ${user.uid}`);
    if (!document) {
      return res.status(404).type('text/plain').send('Signature introuvable.');
    }
    res.set({
      'Content-Type': document.mimetype,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff'
    }).send(document.content);
  } catch (err) {
    res.status(500).type('text/plain').send((err as Error).message);
  }
});

router.post('/espace/signature/supprimer', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const holder = await signatureHolder(user.uid);
  if (holder) {
    await deleteDocument(holder.uid, 'SIGNATURE');
  }
  res.redirect('/espace/signature');
});

/**
 * Dossier de changement : un assuré par ligne, avec ce qui manque encore.
 *
 * La cible vient de la comparaison. Le paramètre `option` reprend la stratégie
 * choisie sur la page d'optimisation : regrouper le foyer chez une caisse, ou
 * placer chacun là où il est le moins cher.
 */
router.get('/espace/changement', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const year = targetYear();

  try {
    const [clients, insurances, holder] = await Promise.all([
      Client.find({ userUid: user.uid }).sort({ birthdate: 1 }),
      Insurance.find({ userUid: user.uid, type: 'LAMAL', status: 'ACTIVE' }),
      accountHolder(user.uid)
    ]);

    const documents = await documentsByClient(clients.map((c) => c.uid));
    const hasSignature = holder ? await hasDocument(holder.uid, 'SIGNATURE') : false;
    const hasFeedback = await hasAnsweredSurvey(user.uid);

    // Courriers déjà confiés à ePost. Bornés aux quatre derniers par assuré :
    // la page dit ce qui est parti, elle n'est pas un journal d'exploitation.
    const dispatches = new Map<string, views.ChangeDispatch[]>();
    for (const record of await LetterDispatch.find({ userUid: user.uid })
      .sort({ sentAt: -1 }).limit(40)) {
      const list = dispatches.get(record.clientUid) || [];
      if (list.length < 4) {
        list.push({
          kind: record.kind,
          mode: record.mode,
          sentAt: record.sentAt,
          status: record.status,
          price: record.price,
          error: record.error
        });
      }
      dispatches.set(record.clientUid, list);
    }

    // La comparaison n'est pas indispensable pour résilier : on la tente, et
    // son absence n'empêche pas de produire les lettres.
    let result: Awaited<ReturnType<typeof optimiseLamal>> = null;
    try {
      result = await optimiseLamal(await buildHouseholdContext(user.uid));
    } catch {
      result = null;
    }

    const individual = String(req.query.option || '') === 'individuel';

    // Offre explicitement choisie sur la page de comparaison. Sans elle, la
    // moins chère fait office de défaut — mais on ne l'impose pas : changer de
    // caisse pour son service ou son réseau de médecins est une raison aussi
    // valable que le prix.
    const pickedInsurer = Number.parseInt(String(req.query.caisse ?? ''), 10);
    const pickedTariff = String(req.query.modele || '').trim();
    const picked = Number.isFinite(pickedInsurer)
      ? result?.offers.find((offer) => offer.insurerId === pickedInsurer &&
          (!pickedTariff || offer.tariffCode === pickedTariff))
      : undefined;

    const grouped = picked || result?.offers?.[0];

    const candidates: views.ChangeCandidate[] = clients.map((client) => {
      const contract = insurances.find((i) => i.clientUid === client.uid);
      const plan = result?.individual?.plans.find((p) => p.ref === client.uid);
      // Un choix explicite prime sur tout : c'est celui de l'assuré.
      const target = picked || (individual && plan ? plan.best : grouped);

      // Même caisse et même modèle qu'aujourd'hui : il n'y a rien à changer.
      const sameTariff = Boolean(
        target && contract &&
        target.insurer === contract.provider &&
        (!contract.tariffCode || target.tariffCode === contract.tariffCode)
      );

      return {
        clientUid: client.uid,
        name: describeClient(client),
        currentInsurer: contract?.provider,
        policyNumber: contract?.policyNumber,
        targetInsurer: target?.insurer,
        targetModel: target ? modelLabel(target) : undefined,
        franchise: contract?.franchise,
        monthlySaving: plan?.savings.monthly,
        identityKinds: (documents.get(client.uid) || [])
          .map((d) => d.kind)
          .filter((kind) => kind !== 'SIGNATURE'),
        hasContract: Boolean(contract),
        alreadyOptimal: sameTariff,
        dispatches: dispatches.get(client.uid) || []
      };
    });

    res.type('html').send(views.renderChange({
      email: user.email,
      csrf: csrfToken(req),
      effectiveYear: year,
      deadline: cancellationDeadlineFor(year),
      candidates,
      hasSignature,
      hasFeedback,
      epost: { enabled: epostConfig().enabled, mode: epostConfig().mode },
      // Le choix de caisse voyage tel quel jusqu'aux lettres.
      query: new URLSearchParams({
        ...(Number.isFinite(pickedInsurer) ? { caisse: String(pickedInsurer) } : {}),
        ...(pickedTariff ? { modele: pickedTariff } : {}),
        ...(individual ? { option: 'individuel' } : {})
      }).toString(),
      savings: result
        ? (individual && result.individual ? result.individual.savings : result.potentialSavings)
        : null,
      notice: {
        signee: 'Signature enregistrée.',
        apercu: 'Aperçu ePost obtenu : le prix et les canaux figurent ci-dessous. '
          + 'Aucun courrier n\'a été envoyé.',
        poste: 'Courrier confié à ePost. Il part en recommandé ; son état apparaît ci-dessous.'
      }[String(req.query.msg || '')],
      error: {
        epost: 'ePost n\'a pas pu prendre le courrier en charge. Rien n\'est parti : '
          + 'téléchargez la lettre et postez-la vous-même.',
        'epost-desactive': 'L\'envoi par ePost n\'est pas activé sur ce service.',
        'epost-adresse': 'Nous n\'avons pas l\'adresse postale de cette caisse. '
          + 'Téléchargez la lettre et complétez le destinataire vous-même.'
      }[String(req.query.err || '')]
    }));
  } catch (err) {
    console.error('Erreur du dossier de changement:', err);
    res.status(500).type('html').send('Erreur serveur.');
  }
});

type PreparedLetter =
  | { redirect: string }
  | {
      input: Parameters<typeof renderLetter>[0];
      recipientName: string;
      /** Adresse decomposee, quand la caisse figure au catalogue de l'OFSP. */
      address: InsurerMailingAddress | null;
    };

/**
 * Rassemble tout ce qu'une lettre exige : l'assure, son contrat, la caisse
 * destinataire avec son adresse officielle, et la signature du titulaire.
 *
 * Commun au telechargement et a l'envoi par ePost : les deux doivent produire
 * exactement le meme document, sans quoi l'assure posterait une lettre et en
 * garderait une autre.
 */
async function prepareLetter(req: Request, kind: LetterKind): Promise<PreparedLetter> {
  const user = req.siteUser!;
  const client = await Client.findOne({ uid: req.params.uid, userUid: user.uid });
  if (!client) {
    return { redirect: '/espace/changement' };
  }

  // Le questionnaire conditionne l'accès : la garde est ici et pas seulement
  // dans la page, sinon l'adresse de la lettre suffirait à la contourner.
  if (!await hasAnsweredSurvey(user.uid)) {
    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    return { redirect: `/espace/souscription${query ? `?${query}` : ''}` };
  }

  const year = targetYear();
  const contract = await Insurance.findOne({
    userUid: user.uid, clientUid: client.uid, type: 'LAMAL', status: 'ACTIVE'
  });

  // La signature du titulaire vaut pour tout le foyer : c'est lui qui signe
  // les courriers de ses enfants.
  const holder = await accountHolder(user.uid);
  let signature: Buffer | undefined;
  if (holder) {
    const stored = await retrieveDocument(holder.uid, 'SIGNATURE', `lettre ${kind}`)
      .catch(() => null);
    signature = stored?.content;
  }

  if (!signature) {
    return { redirect: '/espace/signature' };
  }

  // Destinataire : la caisse quittée pour la résiliation, la caisse retenue
  // par la comparaison pour l'affiliation.
  let recipient = contract?.provider;
  let currentInsurerName = contract?.provider;
  let franchise = contract?.franchise;
  let tariffLabel: string | undefined;

  if (kind === 'ENROLMENT') {
    try {
      const result = await optimiseLamal(await buildHouseholdContext(user.uid));
      const individual = String(req.query.option || '') === 'individuel';
      const plan = result?.individual?.plans.find((p) => p.ref === client.uid);

      // La caisse retenue par l'assuré, transmise depuis la comparaison.
      const pickedInsurer = Number.parseInt(String(req.query.caisse ?? ''), 10);
      const pickedTariff = String(req.query.modele || '').trim();
      const picked = Number.isFinite(pickedInsurer)
        ? result?.offers.find((offer) => offer.insurerId === pickedInsurer &&
            (!pickedTariff || offer.tariffCode === pickedTariff))
        : undefined;

      const target = picked || (individual && plan ? plan.best : result?.offers?.[0]);
      if (target) {
        recipient = target.insurer;
        tariffLabel = modelLabel(target);
      }
    } catch {
      // Sans comparaison, la lettre reste produite : l'assuré complétera le
      // destinataire à la main plutôt que de repartir les mains vides.
    }
  }

  // Adresse postale officielle de la caisse, publiée par l'OFSP dans la liste
  // des assureurs admis. Sans elle, la lettre ne porte qu'un nom et l'assuré
  // doit chercher l'adresse lui-même — pour un recommandé, c'est rédhibitoire.
  const catalogueYear = (await activeYear())?.year;
  const address = catalogueYear && recipient
    ? await insurerAddressByName(catalogueYear, recipient)
    : null;

  return {
    input: {
      kind,
      client,
      recipient: address || { name: recipient || 'Votre caisse maladie', lines: [] },
      effectiveYear: year,
      contract: contract || undefined,
      currentInsurerName,
      franchise,
      tariffLabel,
      employerAccidentCoverage: contract?.employerAccidentCoverage,
      signature
    },
    recipientName: address?.name || recipient || 'Votre caisse maladie',
    address
  };
}

/**
 * Produit une lettre en PDF.
 *
 * Rien n'est conservé : le document porte le nom, l'adresse et le numéro
 * d'assuré, et il se reconstruit à l'identique au téléchargement suivant.
 */
async function serveLetter(req: Request, res: Response, kind: LetterKind) {
  let prepared: PreparedLetter;
  try {
    prepared = await prepareLetter(req, kind);
  } catch (err) {
    console.error('Erreur de préparation de lettre:', err);
    return res.status(500).type('text/plain').send('La lettre n\'a pas pu être produite.');
  }

  if ('redirect' in prepared) {
    return res.redirect(prepared.redirect);
  }

  try {
    const pdf = await renderLetter(prepared.input);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${letterFilename(prepared.input)}"`,
      'Cache-Control': 'no-store, private'
    }).send(pdf);
  } catch (err) {
    console.error('Erreur de génération de lettre:', err);
    res.status(500).type('text/plain').send('La lettre n\'a pas pu être produite.');
  }
}

router.get('/espace/changement/:uid/resiliation', (req, res) =>
  serveLetter(req, res, 'CANCELLATION'));
router.get('/espace/changement/:uid/affiliation', (req, res) =>
  serveLetter(req, res, 'ENROLMENT'));

/**
 * Confie une lettre à ePost.
 *
 * En POST et sous jeton CSRF : c'est une action qui engage — en mode réel elle
 * poste un recommandé facturé, et une résiliation partie ne se reprend pas.
 *
 * Le mode aperçu emprunte exactement le même chemin — jeton, multipart,
 * adresses — mais ePost n'envoie rien et se contente d'annoncer les canaux et
 * le prix. C'est le mode par défaut, et le seul à utiliser tant que le compte
 * n'est pas celui de production.
 */
async function sendLetter(req: Request, res: Response, kind: LetterKind) {
  const user = req.siteUser!;
  const config = epostConfig();

  // Le choix de caisse voyage dans le formulaire : sans lui, le retour sur la
  // page du changement perdrait la comparaison et proposerait autre chose.
  const forward = new URLSearchParams(String(req.body?.query || ''));
  const backTo = (flag: string) => {
    const query = new URLSearchParams(forward);
    const [key, value] = flag.split('=');
    query.set(key, value);
    return `/espace/changement?${query.toString()}`;
  };

  if (!config.enabled) {
    return res.redirect(backTo('err=epost-desactive'));
  }

  let prepared: PreparedLetter;
  try {
    prepared = await prepareLetter(req, kind);
  } catch (err) {
    console.error('Erreur de préparation de lettre:', err);
    return res.redirect(backTo('err=epost'));
  }

  if ('redirect' in prepared) {
    return res.redirect(prepared.redirect);
  }

  const { input, recipientName, address } = prepared;
  // Sans adresse postale, ePost n'a rien à distribuer : mieux vaut le dire que
  // de laisser partir un envoi qui reviendra faute de destinataire.
  if (!address || !address.lines.length) {
    return res.redirect(backTo('err=epost-adresse'));
  }

  const reference = `HLV-${kind === 'CANCELLATION' ? 'RES' : 'AFF'}-${
    input.client.uid.slice(0, 8)}-${input.effectiveYear}`;

  try {
    const pdf = await renderLetter(input);
    const result = await dispatchLetter({
      pdf,
      filename: letterFilename(input),
      sender: input.client,
      recipient: address,
      title: letterTitle(kind, input.effectiveYear),
      reference
    }, config);

    await LetterDispatch.create({
      userUid: user.uid,
      clientUid: input.client.uid,
      kind,
      effectiveYear: input.effectiveYear,
      mode: result.mode,
      recipientName,
      deliveryId: result.deliveryId,
      reference,
      status: result.status,
      price: result.price,
      channels: result.channels,
      error: result.error
    });

    return res.redirect(backTo(result.error
      ? 'err=epost'
      : `msg=${result.mode === 'LIVE' ? 'poste' : 'apercu'}`));
  } catch (err) {
    console.error('Erreur d\'envoi ePost:', err);
    // L'échec est journalisé lui aussi : une lettre que l'assuré croit partie
    // et qui ne l'est pas est la panne la plus coûteuse du service.
    await LetterDispatch.create({
      userUid: user.uid,
      clientUid: input.client.uid,
      kind,
      effectiveYear: input.effectiveYear,
      mode: config.mode,
      recipientName,
      reference,
      channels: [],
      error: err instanceof Error ? err.message : String(err)
    }).catch(() => undefined);
    return res.redirect(backTo('err=epost'));
  }
}

// Le corps urlencodé et le jeton CSRF sont déjà exigés par le routeur : ces
// deux routes n'ont rien de particulier à ajouter.
router.post('/espace/changement/:uid/resiliation/envoyer', (req, res) =>
  sendLetter(req, res, 'CANCELLATION'));
router.post('/espace/changement/:uid/affiliation/envoyer', (req, res) =>
  sendLetter(req, res, 'ENROLMENT'));


router.get('/espace/souscription', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const context = await currentSavings(user.uid);

  res.type('html').send(views.renderSubscription({
    email: user.email,
    csrf: csrfToken(req),
    values: {},
    picked: {
      insurerId: String(req.query.caisse || '') || undefined,
      tariffCode: String(req.query.modele || '') || undefined,
      option: String(req.query.option || '') || undefined
    },
    savings: context.savings,
    // Le choix fait dans les onglets prime sur la stratégie la plus avantageuse.
    strategy: String(req.query.option || '') === 'individuel'
      ? 'INDIVIDUAL'
      : String(req.query.option || '') === 'groupe' ? 'GROUPED' : context.strategy
  }));
});

router.post('/espace/souscription', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const body = req.body as Record<string, unknown>;
  const str = (key: string, max: number) => String(body[key] ?? '').trim().slice(0, max);

  const values = {
    interest: str('interest', 20),
    priceExpectation: str('priceExpectation', 200),
    betaTester: body.betaTester === 'true',
    recontact: body.recontact === 'true',
    contactPhone: str('contactPhone', 40),
    experienceRating: str('experienceRating', 2),
    experienceComment: str('experienceComment', 4000),
    improvements: str('improvements', 4000),
    strategy: str('strategy', 40)
  };

  const fail = async (error: string, invalid: string[]) => {
    const context = await currentSavings(user.uid);
    res.status(400).type('html').send(views.renderSubscription({
      email: user.email,
      csrf: csrfToken(req),
      values,
      picked: {
        insurerId: String(req.body.caisse || '') || undefined,
        tariffCode: String(req.body.modele || '') || undefined,
        option: String(req.body.option || '') || undefined
      },
      savings: context.savings,
      strategy: values.strategy || context.strategy,
      error,
      invalid
    }));
  };

  if (!INTEREST_LEVELS.includes(values.interest as InterestLevel)) {
    return fail('Indiquez si ce service vous intéresserait.', ['interest']);
  }

  const rating = Number.parseInt(values.experienceRating, 10);
  const savings = Number.parseFloat(String(body.savingsMonthly ?? ''));

  try {
    await Feedback.create({
      userUid: user.uid,
      email: user.email,
      interest: values.interest,
      priceExpectation: values.priceExpectation || undefined,
      betaTester: values.betaTester,
      recontact: values.recontact,
      // Sans accord de rappel, le numéro n'a aucune raison d'être conservé.
      contactPhone: values.recontact && values.contactPhone ? values.contactPhone : undefined,
      experienceRating: Number.isFinite(rating) && rating >= 1 && rating <= 5 ? rating : undefined,
      experienceComment: values.experienceComment || undefined,
      improvements: values.improvements || undefined,
      shownSavingsMonthly: Number.isFinite(savings) ? savings : undefined,
      shownStrategy: values.strategy || undefined
    });

    // Le choix de caisse fait sur la comparaison est reconduit : l'assuré
    // revient exactement là où il en était, sans avoir à le refaire.
    const forward = new URLSearchParams();
    for (const key of ['caisse', 'modele', 'option']) {
      const value = String(req.body[key] ?? req.query[key] ?? '').trim();
      if (value) { forward.set(key, value); }
    }

    res.type('html').send(views.renderSubscriptionThanks({
      email: user.email,
      betaTester: values.betaTester,
      recontact: values.recontact,
      changeHref: '/espace/changement' + (forward.toString() ? '?' + forward.toString() : '')
    }));
  } catch (err) {
    console.error('Erreur d\'enregistrement du retour d\'expérience:', err);
    return fail('Votre réponse n\'a pas pu être enregistrée. Réessayez.', []);
  }
});

export { router as siteRouter };
