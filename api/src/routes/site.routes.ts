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
import { csrfToken, verifyCsrf, isCsrfValid, CSRF_REJECTION_MESSAGE } from '../utils/csrf';
import {
  describeExtraction,
  extractFromDocument,
  isSupportedDocument,
  ExtractionResult
} from '../services/document-extraction.service';
import { readClientPayload } from '../utils/client-payload';
import { readInsurancePayload } from '../utils/insurance-payload';
import { monthlyPremium, cancellationDeadline } from '../utils/insurance-payload';
import {
  ageAt,
  buildHouseholdContext,
  HouseholdError,
  nearestLegalFranchise,
  isFirstClientOfHousehold,
  PHONE_REQUIRED_MESSAGE
} from '../services/household.service';
import { optimiseLamal } from '../services/lamal-optimisation.service';
import { Catalogue, catalogueFor, premiumFor } from '../services/premium-catalogue.service';
import * as views from '../views/site/pages';
import { Values } from '../views/site/forms';

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
    ['avsNum', 'birthdate', 'firstname', 'name', 'plz', 'location']);
}

function applyToInsurance(values: Values, result: ExtractionResult): Values {
  return applyExtraction(values, result,
    ['provider', 'policyNumber', 'premiumAmount', 'franchise']);
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
    confirme: 'Adresse confirmée : vous pouvez vous connecter.'
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
    if (!user.emailVerified) {
      return fail('Confirmez votre adresse email avant de vous connecter. ' +
        'Le lien vous a été envoyé lors de votre inscription.', 403);
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

// -------------------------------------------------------------- inscription

router.get('/inscription', async (req: Request, res: Response) => {
  if (await currentUser(req)) {
    return res.redirect('/espace');
  }
  res.type('html').send(views.renderRegister({
    csrf: csrfToken(req),
    values: { nationality: 'CH' }
  }));
});

router.post('/inscription', async (req: Request, res: Response) => {
  const values = fieldValues(req.body, [...CLIENT_FIELDS, 'accountEmail']);
  const accountEmail = String(req.body.accountEmail || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const fail = (error: string, status = 400, invalidFields: string[] = []) =>
    res.status(status).type('html').send(
      views.renderRegister({ csrf: csrfToken(req), values, error, invalidFields })
    );

  if (!EMAIL_PATTERN.test(accountEmail)) {
    return fail('Adresse email de connexion invalide.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }

  // L'assuré hérite de l'email du compte si le champ est laissé vide.
  const payload = readClientPayload(req.body, { email: accountEmail });
  if (payload.error || !payload.values) {
    return fail(payload.error || 'Données incomplètes.');
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

  try {
    const salt = generateSalt();
    const user = new User({ email: accountEmail, salt, password: await hashPassword(password, salt) });
    const token = generateToken();
    user.emailTokenHash = hashToken(token);
    user.emailTokenExpiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_MS);
    await user.save();

    // Pas de transaction : si le client échoue, l'utilisateur est retiré pour
    // ne pas laisser un compte orphelin qui bloquerait une nouvelle tentative.
    try {
      await Client.create({ ...payload.values, userUid: user.uid });
    } catch (clientErr) {
      await User.deleteOne({ uid: user.uid });
      throw clientErr;
    }

    const emailSent = await sendConfirmationEmail(user.email, token);
    res.type('html').send(views.renderRegistered(user.email, emailSent));
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
      notice: String(req.query.msg || '') === 'ok' ? 'Modifications enregistrées.' : undefined
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

  res.type('html').send(views.renderClients({
    email: user.email,
    clients,
    insuranceCount: new Map(counts.map((c) => [c._id, c.n])),
    notice: String(req.query.msg || '') === 'ok' ? 'Assuré enregistré.' : undefined
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
    label: `${reference.firstname} ${reference.name}`,
    road: reference.road,
    plz: reference.plz,
    location: reference.location,
    canton: reference.canton
  };
}

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

  const payload = readClientPayload(req.body, { email: user.email });
  if (payload.error || !payload.values) {
    return fail(payload.error || 'Données incomplètes.');
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

  const payload = readClientPayload(req.body, { email: user.email });
  if (payload.error || !payload.values) {
    return fail(payload.error || 'Données incomplètes.');
  }

  try {
    // Le filtre porte le userUid : un assuré d'un autre foyer est introuvable.
    const result = await Client.findOneAndUpdate(
      { uid: req.params.uid, userUid: user.uid },
      { $set: payload.values },
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

async function insuredOptions(userUid: string): Promise<Array<[string, string]>> {
  const clients = await Client.find({ userUid }).sort({ birthdate: 1 });
  return clients.map((c) => [c.uid, `${c.firstname} ${c.name}`] as [string, string]);
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
  res.type('html').send(views.renderInsuranceForm({
    email: user.email,
    csrf: csrfToken(req),
    values: {
      type: 'LAMAL',
      status: 'ACTIVE',
      premiumFrequency: 'MENSUEL',
      autoRenew: true,
      clientUid: String(req.query.assure || '')
    },
    insuredOptions: await insuredOptions(user.uid),
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

/** Analyse un document et réaffiche le formulaire de contrat pré-rempli. */
router.post('/espace/assurances/importer', upload.single('document'), verifyUploadCsrf,
  async (req: Request, res: Response) => {
    const user = req.siteUser!;
    const base: Values = {
      type: 'LAMAL', status: 'ACTIVE', premiumFrequency: 'MENSUEL', autoRenew: true
    };

    const render = async (values: Values, extra: { error?: string; info?: string; warnings?: string[] } = {}) =>
      res.type('html').send(views.renderInsuranceForm({
        email: user.email,
        csrf: csrfToken(req),
        values,
        insuredOptions: await insuredOptions(user.uid),
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

      // Le document désigne souvent une personne : on tente de la retrouver
      // dans le foyer par son numéro AVS, qui est sans ambiguïté.
      const warnings = [...result.warnings];
      if (result.fields.avsNum) {
        const match = await Client.findOne({ userUid: user.uid, avsNum: result.fields.avsNum.value });
        if (match) {
          values.clientUid = match.uid;
        } else {
          warnings.push(
            `Le numéro AVS ${result.fields.avsNum.value} ne correspond à aucun assuré de votre foyer : ` +
            'choisissez la personne concernée.'
          );
        }
      }

      await render(values, { info: describeExtraction(result), warnings });
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

router.get('/espace/souscription', async (req: Request, res: Response) => {
  const user = req.siteUser!;
  const context = await currentSavings(user.uid);

  res.type('html').send(views.renderSubscription({
    email: user.email,
    csrf: csrfToken(req),
    values: {},
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

    res.type('html').send(views.renderSubscriptionThanks({
      email: user.email,
      betaTester: values.betaTester,
      recontact: values.recontact
    }));
  } catch (err) {
    console.error('Erreur d\'enregistrement du retour d\'expérience:', err);
    return fail('Votre réponse n\'a pas pu être enregistrée. Réessayez.', []);
  }
});

export { router as siteRouter };
