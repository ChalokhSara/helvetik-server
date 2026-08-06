import { Router, Request, Response } from 'express';
import { Client, IClient } from '../models/client.model';
import { Insurance, IInsurance, PremiumFrequency } from '../models/insurance.model';
import { User } from '../models/user.model';
import { csrfToken } from '../utils/csrf';
import { buildBaseUrl, escapeRegex, PAGE_SIZE, parsePage } from '../utils/query';
import { monthlyPremium } from '../utils/insurance-payload';
import {
  ClientOption,
  InsuranceFormValues,
  insuranceToFormValues,
  renderInsuranceFormPage,
  renderInsuranceListPage
} from '../views/admin-insurances.view';

const router = Router();

/** Plafond du sélecteur d'assuré : au-delà, la liste déroulante n'a plus de sens. */
const CLIENT_OPTIONS_LIMIT = 500;

const NOTICES: Record<string, string> = {
  created: 'Assurance créée.',
  updated: 'Assurance mise à jour.',
  deleted: 'Assurance supprimée.'
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
    return { message: 'Cette assurance existe déjà.', status: 409 };
  }
  if (error?.name === 'ValidationError' && error.errors) {
    return { message: Object.values(error.errors).map((e) => e.message).join(' '), status: 400 };
  }
  return { message: 'Erreur serveur.', status: 500 };
}

/** Champs du formulaire, normalisés depuis le corps de la requête. */
function readFormValues(body: Record<string, unknown>): InsuranceFormValues {
  const str = (key: string) => String(body[key] ?? '').trim();

  return {
    clientUid: str('clientUid'),
    provider: str('provider'),
    productName: str('productName'),
    type: str('type'),
    description: str('description'),
    policyNumber: str('policyNumber'),
    startDate: str('startDate'),
    endDate: str('endDate'),
    status: str('status'),
    premiumAmount: str('premiumAmount'),
    premiumFrequency: str('premiumFrequency'),
    currency: str('currency'),
    franchise: str('franchise'),
    coverageAmount: str('coverageAmount'),
    cancellationNoticeMonths: str('cancellationNoticeMonths'),
    autoRenew: body.autoRenew !== 'false',
    employerAccidentCoverage: body.employerAccidentCoverage === 'true',
    tariffType: str('tariffType'),
    tariffCode: str('tariffCode'),
    notes: str('notes')
  };
}

/** Nombre optionnel : une case vide reste vide, elle ne devient pas zéro. */
function optionalNumber(raw?: string): number | undefined {
  const value = String(raw ?? '').trim();
  return value === '' ? undefined : Number(value);
}

async function listClientOptions(): Promise<ClientOption[]> {
  const clients = await Client.find()
    .sort({ name: 1, firstname: 1 })
    .limit(CLIENT_OPTIONS_LIMIT);

  const emails = await mapUserEmails(clients);
  return clients.map((client) => ({
    uid: client.uid,
    name: client.name,
    firstname: client.firstname,
    userEmail: emails.get(client.userUid)
  }));
}

/** Emails des titulaires, pour distinguer deux homonymes dans le sélecteur. */
async function mapUserEmails(clients: IClient[]): Promise<Map<string, string>> {
  const uids = [...new Set(clients.map((client) => client.userUid))];
  const users = await User.find({ uid: { $in: uids } }).select('uid email');
  return new Map(users.map((user) => [user.uid, user.email]));
}

/** Assurés des contrats affichés, indexés par uid, pour éviter un N+1. */
async function mapClients(insurances: IInsurance[]): Promise<Map<string, ClientOption>> {
  const uids = [...new Set(insurances.map((insurance) => insurance.clientUid))];
  const clients = await Client.find({ uid: { $in: uids } });
  return new Map(clients.map((client) => [
    client.uid,
    { uid: client.uid, name: client.name, firstname: client.firstname }
  ]));
}

/**
 * Liste paginée, filtrable par texte libre, type, statut et assuré.
 */
router.get('/', async (req: Request, res: Response) => {
  const search = String(req.query.q || '').trim();
  const type = String(req.query.type || '').trim();
  const status = String(req.query.status || '').trim();
  const clientUid = String(req.query.clientUid || '').trim();
  const page = parsePage(req.query.page);

  const filter: Record<string, unknown> = {};
  if (type) {
    filter.type = type;
  }
  if (status) {
    filter.status = status;
  }
  if (clientUid) {
    filter.clientUid = clientUid;
  }
  if (search) {
    const regex = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [
      { provider: regex },
      { productName: regex },
      { policyNumber: regex },
      { description: regex }
    ];
  }

  const baseUrl = buildBaseUrl('/admin/insurances', { q: search, type, status, clientUid });

  try {
    const [insurances, total, premiumGroups] = await Promise.all([
      Insurance.find(filter)
        .sort({ provider: 1, productName: 1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE),
      Insurance.countDocuments(filter),
      // Le total des primes porte sur tout le filtre, pas sur la page affichée.
      Insurance.aggregate<{ _id: PremiumFrequency; amount: number }>([
        { $match: filter },
        { $group: { _id: '$premiumFrequency', amount: { $sum: '$premiumAmount' } } }
      ])
    ]);

    const clients = await mapClients(insurances);
    if (clientUid && !clients.has(clientUid)) {
      const insured = await Client.findOne({ uid: clientUid });
      if (insured) {
        clients.set(insured.uid, {
          uid: insured.uid,
          name: insured.name,
          firstname: insured.firstname
        });
      }
    }

    const monthlyTotal = premiumGroups.reduce(
      (sum, group) => sum + monthlyPremium(group.amount, group._id),
      0
    );

    res.type('html').send(renderInsuranceListPage({
      username: adminName(req),
      insurances,
      clients,
      search,
      type,
      status,
      clientUid,
      csrf: csrfToken(req),
      page: { page, pageSize: PAGE_SIZE, total, baseUrl },
      monthlyTotal,
      notice: NOTICES[String(req.query.msg || '')]
    }));
  } catch (err) {
    console.error('Erreur de listing des assurances:', err);
    res.status(500).type('html').send(renderInsuranceListPage({
      username: adminName(req),
      insurances: [],
      clients: new Map(),
      search,
      type,
      status,
      clientUid,
      csrf: csrfToken(req),
      page: { page: 1, pageSize: PAGE_SIZE, total: 0, baseUrl: '/admin/insurances?' },
      monthlyTotal: 0,
      error: 'Impossible de charger les assurances.'
    }));
  }
});

router.get('/new', async (req: Request, res: Response) => {
  try {
    res.type('html').send(renderInsuranceFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      // Pré-sélectionne l'assuré quand on arrive depuis sa fiche.
      values: {
        clientUid: String(req.query.clientUid || ''),
        status: 'ACTIVE',
        premiumFrequency: 'MENSUEL',
        currency: 'CHF',
        autoRenew: true
      },
      clients: await listClientOptions()
    }));
  } catch (err) {
    console.error('Erreur de chargement du formulaire d\'assurance:', err);
    res.redirect('/admin/insurances');
  }
});

/**
 * Valide les champs que le schéma Mongoose ne peut pas voir (dates parsables,
 * cohérence entre elles, assuré existant) et renvoie les valeurs converties.
 */
async function validate(
  values: InsuranceFormValues
): Promise<{ error: string; startDate?: undefined; endDate?: undefined } | { error?: undefined; startDate: Date; endDate: Date }> {
  const startDate = new Date(values.startDate || '');
  if (Number.isNaN(startDate.getTime())) {
    return { error: 'La date de début est invalide.' };
  }

  if (!values.endDate) {
    return { error: 'La date de fin est obligatoire.' };
  }
  const endDate = new Date(values.endDate);
  if (Number.isNaN(endDate.getTime())) {
    return { error: 'La date de fin est invalide.' };
  }

  if (!values.clientUid || !await Client.exists({ uid: values.clientUid })) {
    return { error: 'L\'assuré est introuvable.' };
  }

  return { startDate, endDate };
}

router.post('/new', async (req: Request, res: Response) => {
  const values = readFormValues(req.body);

  const fail = async (error: string, status = 400) =>
    res.status(status).type('html').send(renderInsuranceFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      values,
      clients: await listClientOptions(),
      error
    }));

  const checked = await validate(values);
  if (checked.error) {
    return fail(checked.error);
  }

  try {
    // Le titulaire est déduit de l'assuré : les deux ne peuvent pas diverger.
    const client = await Client.findOne({ uid: values.clientUid });
    if (!client) {
      return fail('L\'assuré est introuvable.');
    }

    await Insurance.create({
      userUid: client.userUid,
      clientUid: values.clientUid,
      provider: values.provider,
      productName: values.productName,
      type: values.type,
      description: values.description || undefined,
      policyNumber: values.policyNumber,
      startDate: checked.startDate,
      endDate: checked.endDate,
      status: values.status || 'ACTIVE',
      premiumAmount: optionalNumber(values.premiumAmount),
      premiumFrequency: values.premiumFrequency || 'MENSUEL',
      currency: values.currency || 'CHF',
      franchise: optionalNumber(values.franchise),
      coverageAmount: optionalNumber(values.coverageAmount),
      cancellationNoticeMonths: optionalNumber(values.cancellationNoticeMonths),
      autoRenew: values.autoRenew !== false,
      employerAccidentCoverage: values.employerAccidentCoverage === true,
      tariffType: values.tariffType || undefined,
      tariffCode: values.tariffCode || undefined,
      notes: values.notes || undefined
    });

    res.redirect('/admin/insurances?msg=created');
  } catch (err) {
    console.error('Erreur de création d\'assurance:', err);
    const described = describeError(err);
    return fail(described.message, described.status);
  }
});

router.get('/:uid/edit', async (req: Request, res: Response) => {
  try {
    const insurance = await Insurance.findOne({ uid: req.params.uid });
    if (!insurance) {
      return res.status(404).redirect('/admin/insurances');
    }

    res.type('html').send(renderInsuranceFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      uid: insurance.uid,
      values: insuranceToFormValues(insurance),
      clients: await listClientOptions()
    }));
  } catch (err) {
    console.error('Erreur de chargement d\'assurance:', err);
    res.redirect('/admin/insurances');
  }
});

router.post('/:uid/edit', async (req: Request, res: Response) => {
  const values = readFormValues(req.body);

  const fail = async (error: string, status = 400) =>
    res.status(status).type('html').send(renderInsuranceFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      uid: req.params.uid,
      values,
      clients: await listClientOptions(),
      error
    }));

  const checked = await validate(values);
  if (checked.error) {
    return fail(checked.error);
  }

  try {
    const insurance = await Insurance.findOne({ uid: req.params.uid });
    if (!insurance) {
      return res.status(404).redirect('/admin/insurances');
    }

    const client = await Client.findOne({ uid: values.clientUid });
    if (!client) {
      return fail('L\'assuré est introuvable.');
    }

    // Déplacer un contrat vers un assuré d'un autre foyer doit aussi déplacer
    // le titulaire, sinon le contrat resterait invisible pour son propriétaire.
    insurance.userUid = client.userUid;
    insurance.clientUid = values.clientUid!;
    insurance.provider = values.provider!;
    insurance.productName = values.productName!;
    insurance.type = values.type as IInsurance['type'];
    insurance.description = values.description || undefined;
    insurance.policyNumber = values.policyNumber!;
    insurance.startDate = checked.startDate!;
    insurance.endDate = checked.endDate!;
    insurance.status = (values.status || 'ACTIVE') as IInsurance['status'];
    insurance.premiumAmount = optionalNumber(values.premiumAmount) as number;
    insurance.premiumFrequency = (values.premiumFrequency || 'MENSUEL') as IInsurance['premiumFrequency'];
    insurance.currency = values.currency || 'CHF';
    insurance.franchise = optionalNumber(values.franchise);
    insurance.coverageAmount = optionalNumber(values.coverageAmount);
    insurance.cancellationNoticeMonths = optionalNumber(values.cancellationNoticeMonths);
    insurance.autoRenew = values.autoRenew !== false;
    insurance.employerAccidentCoverage = values.employerAccidentCoverage === true;
    insurance.tariffType = (values.tariffType || undefined) as IInsurance['tariffType'];
    insurance.tariffCode = values.tariffCode || undefined;
    insurance.notes = values.notes || undefined;

    await insurance.save();
    res.redirect('/admin/insurances?msg=updated');
  } catch (err) {
    console.error('Erreur de mise à jour d\'assurance:', err);
    const described = describeError(err);
    return fail(described.message, described.status);
  }
});

/**
 * Suppression définitive. Contrairement aux utilisateurs et aux clients, qui
 * sont bloqués pour conserver l'historique, un contrat saisi par erreur n'a
 * pas vocation à subsister — un contrat réel qui prend fin passe en « Résiliée ».
 */
router.post('/:uid/delete', async (req: Request, res: Response) => {
  try {
    const result = await Insurance.deleteOne({ uid: req.params.uid });
    if (result.deletedCount === 0) {
      return res.status(404).redirect('/admin/insurances');
    }
    res.redirect('/admin/insurances?msg=deleted');
  } catch (err) {
    console.error('Erreur de suppression d\'assurance:', err);
    res.redirect('/admin/insurances');
  }
});

export { router as adminInsurancesRouter };
