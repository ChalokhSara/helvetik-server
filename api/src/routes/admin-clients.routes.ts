import { Router, Request, Response } from 'express';
import { Client, IClient } from '../models/client.model';
import { User } from '../models/user.model';
import { csrfToken } from '../utils/csrf';
import {
  documentsByClient,
  listDocuments,
  retrieveDocument
} from '../services/document-vault.service';
import {
  DOCUMENT_SIDES,
  DocumentSide,
  SIDE_LABELS
} from '../models/identity-document.model';
import { isFirstClientOfHousehold, PHONE_REQUIRED_MESSAGE } from '../services/household.service';
import { buildBaseUrl, escapeRegex, PAGE_SIZE, parsePage } from '../utils/query';
import {
  ClientFormValues,
  clientToFormValues,
  renderClientFormPage,
  renderClientDocumentsPage,
  renderClientListPage,
  UserOption
} from '../views/admin-clients.view';

const router = Router();

/** Plafond du sélecteur de titulaire : au-delà, la liste déroulante n'a plus de sens. */
const USER_OPTIONS_LIMIT = 500;

const NOTICES: Record<string, string> = {
  created: 'Client créé.',
  updated: 'Client mis à jour.',
  blocked: 'Client bloqué.',
  unblocked: 'Client débloqué.'
};

function adminName(req: Request): string {
  return req.session.adminUsername || '';
}

/**
 * Traduit une erreur Mongo/Mongoose en message affichable. Une saisie refusée
 * reste une erreur du client (400), seul l'imprévu donne un 500.
 */
function describeError(err: unknown): { message: string; status: number } {
  const error = err as { code?: number; name?: string; errors?: Record<string, { message: string }> };

  if (error?.code === 11000) {
    return { message: 'Ce client existe déjà.', status: 409 };
  }
  if (error?.name === 'ValidationError' && error.errors) {
    return { message: Object.values(error.errors).map((e) => e.message).join(' '), status: 400 };
  }
  return { message: 'Erreur serveur.', status: 500 };
}

/** Champs du formulaire, normalisés depuis le corps de la requête. */
function readFormValues(body: Record<string, unknown>): ClientFormValues {
  const str = (key: string) => String(body[key] ?? '').trim();

  return {
    userUid: str('userUid'),
    name: str('name'),
    firstname: str('firstname'),
    birthdate: str('birthdate'),
    email: str('email').toLowerCase(),
    // Champ facultatif : on enregistre son absence plutôt qu'une chaîne vide.
    phone: str('phone') || undefined,
    road: str('road'),
    plz: str('plz'),
    location: str('location'),
    canton: str('canton'),
    nationality: str('nationality'),
    avsNum: str('avsNum'),
    sexe: str('sexe'),
    blocked: body.blocked === 'true'
  };
}

async function listUserOptions(): Promise<UserOption[]> {
  const users = await User.find().sort({ email: 1 }).limit(USER_OPTIONS_LIMIT);
  return users.map((user) => ({ uid: user.uid, email: user.email, blocked: user.blocked }));
}

/** Emails des titulaires des clients affichés, pour éviter un N+1. */
async function mapUserEmails(clients: IClient[]): Promise<Map<string, string>> {
  const uids = [...new Set(clients.map((client) => client.userUid))];
  const users = await User.find({ uid: { $in: uids } }).select('uid email');
  return new Map(users.map((user) => [user.uid, user.email]));
}

/**
 * Liste paginée, filtrable par texte libre et par utilisateur titulaire.
 */
router.get('/', async (req: Request, res: Response) => {
  const search = String(req.query.q || '').trim();
  const userUid = String(req.query.userUid || '').trim();
  const page = parsePage(req.query.page);

  const filter: Record<string, unknown> = {};
  if (userUid) {
    filter.userUid = userUid;
  }
  if (search) {
    const regex = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [
      { name: regex },
      { firstname: regex },
      { email: regex },
      { avsNum: regex }
    ];
  }

  try {
    const [clients, total] = await Promise.all([
      Client.find(filter)
        .sort({ name: 1, firstname: 1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE),
      Client.countDocuments(filter)
    ]);

    const userEmails = await mapUserEmails(clients);
    if (userUid && !userEmails.has(userUid)) {
      const holder = await User.findOne({ uid: userUid }).select('uid email');
      if (holder) {
        userEmails.set(holder.uid, holder.email);
      }
    }

    // État du dossier d'identité, affiché dans la liste : sans les deux faces,
    // aucune lettre de résiliation ne peut être envoyée.
    const byClient = await documentsByClient(clients.map((c) => c.uid));
    const documents = new Map(
      [...byClient].map(([uid, docs]) => [uid, docs.map((d) => d.side)])
    );

    res.type('html').send(renderClientListPage({
      username: adminName(req),
      clients,
      userEmails,
      documents,
      search,
      userUid,
      csrf: csrfToken(req),
      page: {
        page,
        pageSize: PAGE_SIZE,
        total,
        baseUrl: buildBaseUrl('/admin/clients', { q: search, userUid })
      },
      notice: NOTICES[String(req.query.msg || '')]
    }));
  } catch (err) {
    console.error('Erreur de listing des clients:', err);
    res.status(500).type('html').send(renderClientListPage({
      username: adminName(req),
      clients: [],
      userEmails: new Map(),
      documents: new Map(),
      search,
      userUid,
      csrf: csrfToken(req),
      page: { page: 1, pageSize: PAGE_SIZE, total: 0, baseUrl: '/admin/clients?' },
      error: 'Impossible de charger les clients.'
    }));
  }
});

router.get('/new', async (req: Request, res: Response) => {
  try {
    res.type('html').send(renderClientFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      // Pré-sélectionne le titulaire quand on arrive depuis sa fiche.
      values: { userUid: String(req.query.userUid || '') },
      users: await listUserOptions()
    }));
  } catch (err) {
    console.error('Erreur de chargement du formulaire client:', err);
    res.redirect('/admin/clients');
  }
});

router.post('/new', async (req: Request, res: Response) => {
  const values = readFormValues(req.body);

  const fail = async (error: string, status = 400) =>
    res.status(status).type('html').send(renderClientFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      values,
      users: await listUserOptions(),
      error
    }));

  // L'identité n'est plus exigée : une fiche peut n'avoir qu'un contact,
  // une adresse et un numéro AVS tant que la pièce n'a pas été lue.
  let birthdate: Date | undefined;
  if (values.birthdate) {
    birthdate = new Date(values.birthdate);
    if (Number.isNaN(birthdate.getTime())) {
      return fail('La date de naissance est invalide.');
    }
  }
  if (!await User.exists({ uid: values.userUid })) {
    return fail('L\'utilisateur titulaire est introuvable.');
  }
  // Le premier assuré d'un compte en est le contact : son numéro est exigé.
  if (!values.phone && await isFirstClientOfHousehold(values.userUid!)) {
    return fail(PHONE_REQUIRED_MESSAGE);
  }

  try {
    await Client.create({
      ...values,
      birthdate,
      blockedAt: values.blocked ? new Date() : undefined
    });
    res.redirect('/admin/clients?msg=created');
  } catch (err) {
    console.error('Erreur de création de client:', err);
    const described = describeError(err);
    return fail(described.message, described.status);
  }
});

router.get('/:uid/edit', async (req: Request, res: Response) => {
  try {
    const client = await Client.findOne({ uid: req.params.uid });
    if (!client) {
      return res.status(404).redirect('/admin/clients');
    }

    res.type('html').send(renderClientFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      uid: client.uid,
      values: clientToFormValues(client),
      users: await listUserOptions()
    }));
  } catch (err) {
    console.error('Erreur de chargement de client:', err);
    res.redirect('/admin/clients');
  }
});

router.post('/:uid/edit', async (req: Request, res: Response) => {
  const values = readFormValues(req.body);

  const fail = async (error: string, status = 400) =>
    res.status(status).type('html').send(renderClientFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      uid: req.params.uid,
      values,
      users: await listUserOptions(),
      error
    }));

  // L'identité n'est plus exigée : une fiche peut n'avoir qu'un contact,
  // une adresse et un numéro AVS tant que la pièce n'a pas été lue.
  let birthdate: Date | undefined;
  if (values.birthdate) {
    birthdate = new Date(values.birthdate);
    if (Number.isNaN(birthdate.getTime())) {
      return fail('La date de naissance est invalide.');
    }
  }
  if (!await User.exists({ uid: values.userUid })) {
    return fail('L\'utilisateur titulaire est introuvable.');
  }

  try {
    const client = await Client.findOne({ uid: req.params.uid });
    if (!client) {
      return res.status(404).redirect('/admin/clients');
    }

    client.userUid = values.userUid!;
    // Les champs facultatifs vidés sont retirés, jamais enregistrés à '' :
    // une chaîne vide échouerait sur l'énumération du sexe.
    client.name = values.name || undefined;
    client.firstname = values.firstname || undefined;
    client.birthdate = birthdate;
    client.email = values.email!;
    client.phone = values.phone!;
    client.road = values.road!;
    client.plz = values.plz!;
    client.location = values.location!;
    client.canton = values.canton as IClient['canton'];
    client.nationality = values.nationality || undefined;
    client.avsNum = values.avsNum!;
    client.sexe = (values.sexe || undefined) as IClient['sexe'];
    if (client.blocked !== values.blocked) {
      client.blocked = Boolean(values.blocked);
      client.blockedAt = values.blocked ? new Date() : undefined;
    }

    await client.save();
    res.redirect('/admin/clients?msg=updated');
  } catch (err) {
    console.error('Erreur de mise à jour de client:', err);
    const described = describeError(err);
    return fail(described.message, described.status);
  }
});

async function setBlocked(req: Request, res: Response, blocked: boolean) {
  try {
    const result = await Client.updateOne(
      { uid: req.params.uid },
      blocked
        ? { $set: { blocked: true, blockedAt: new Date() } }
        : { $set: { blocked: false }, $unset: { blockedAt: '' } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).redirect('/admin/clients');
    }
    res.redirect(`/admin/clients?msg=${blocked ? 'blocked' : 'unblocked'}`);
  } catch (err) {
    console.error('Erreur de blocage de client:', err);
    res.redirect('/admin/clients');
  }
}

router.post('/:uid/block', (req, res) => setBlocked(req, res, true));
router.post('/:uid/unblock', (req, res) => setBlocked(req, res, false));


// ------------------------------------------------------- pièce d'identité
//
// Les pièces sont conservées pour être jointes aux lettres de résiliation et
// d'affiliation : l'exploitant doit donc pouvoir les récupérer. C'est aussi
// l'accès le plus sensible de toute la console, d'où la trace systématique
// laissée par retrieveDocument().

router.get('/:uid/piece', async (req: Request, res: Response) => {
  const client = await Client.findOne({ uid: req.params.uid });
  if (!client) {
    return res.status(404).redirect('/admin/clients');
  }

  const documents = await listDocuments(client.uid);
  const holder = await User.findOne({ uid: client.userUid }).select('email');

  res.type('html').send(renderClientDocumentsPage({
    username: adminName(req),
    client,
    holderEmail: holder?.email,
    documents
  }));
});

router.get('/:uid/piece/:side', async (req: Request, res: Response) => {
  const side = String(req.params.side || '').toUpperCase() as DocumentSide;
  if (!DOCUMENT_SIDES.includes(side)) {
    return res.status(404).type('text/plain').send('Face inconnue.');
  }

  try {
    const document = await retrieveDocument(
      req.params.uid, side, `console — admin ${adminName(req) || 'inconnu'}`
    );
    if (!document) {
      return res.status(404).type('text/plain').send('Pièce introuvable.');
    }

    // Téléchargement plutôt qu'affichage : depuis la console, la pièce sert à
    // être jointe à un courrier, pas à être regardée.
    res.set({
      'Content-Type': document.mimetype,
      'Content-Disposition':
        `attachment; filename="${req.params.uid}-${side.toLowerCase()}"`,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff'
    }).send(document.content);
  } catch (err) {
    res.status(500).type('text/plain').send((err as Error).message);
  }
});

export { router as adminClientsRouter };
