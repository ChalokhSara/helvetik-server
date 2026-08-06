import { Router, Request, Response } from 'express';
import { User } from '../models/user.model';
import { Client } from '../models/client.model';
import { generateSalt, hashPassword } from '../utils/password';
import { csrfToken } from '../utils/csrf';
import { buildBaseUrl, escapeRegex, PAGE_SIZE, parsePage } from '../utils/query';
import { renderUserFormPage, renderUserListPage, UserFormValues, UserRow } from '../views/admin-users.view';

const router = Router();

export const MIN_PASSWORD_LENGTH = 8;

/** Messages de confirmation, référencés par clé pour ne pas rediriger du texte libre. */
const NOTICES: Record<string, string> = {
  created: 'Utilisateur créé.',
  updated: 'Utilisateur mis à jour.',
  blocked: 'Utilisateur bloqué.',
  unblocked: 'Utilisateur débloqué.'
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
    return { message: 'Cet email est déjà utilisé par un autre utilisateur.', status: 409 };
  }
  if (error?.name === 'ValidationError' && error.errors) {
    return { message: Object.values(error.errors).map((e) => e.message).join(' '), status: 400 };
  }
  return { message: 'Erreur serveur.', status: 500 };
}

/**
 * Liste paginée, filtrable par email.
 */
router.get('/', async (req: Request, res: Response) => {
  const search = String(req.query.q || '').trim();
  const page = parsePage(req.query.page);
  const filter = search ? { email: { $regex: escapeRegex(search), $options: 'i' } } : {};

  try {
    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ creationDate: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE),
      User.countDocuments(filter)
    ]);

    // Un seul aggregate pour les compteurs de la page courante.
    const counts = await Client.aggregate<{ _id: string; count: number }>([
      { $match: { userUid: { $in: users.map((user) => user.uid) } } },
      { $group: { _id: '$userUid', count: { $sum: 1 } } }
    ]);
    const countByUid = new Map(counts.map((entry) => [entry._id, entry.count]));

    const rows: UserRow[] = users.map((user) => ({
      user,
      clientCount: countByUid.get(user.uid) || 0
    }));

    res.type('html').send(renderUserListPage({
      username: adminName(req),
      rows,
      search,
      csrf: csrfToken(req),
      page: { page, pageSize: PAGE_SIZE, total, baseUrl: buildBaseUrl('/admin/users', { q: search }) },
      notice: NOTICES[String(req.query.msg || '')]
    }));
  } catch (err) {
    console.error('Erreur de listing des utilisateurs:', err);
    res.status(500).type('html').send(renderUserListPage({
      username: adminName(req),
      rows: [],
      search,
      csrf: csrfToken(req),
      page: { page: 1, pageSize: PAGE_SIZE, total: 0, baseUrl: '/admin/users?' },
      error: 'Impossible de charger les utilisateurs.'
    }));
  }
});

router.get('/new', (req: Request, res: Response) => {
  res.type('html').send(renderUserFormPage({
    username: adminName(req),
    csrf: csrfToken(req),
    values: {},
    minPasswordLength: MIN_PASSWORD_LENGTH
  }));
});

router.post('/new', async (req: Request, res: Response) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirmPassword || '');
  const blocked = req.body.blocked === 'true';

  const values: UserFormValues = { email, blocked };
  const fail = (error: string, status = 400) =>
    res.status(status).type('html').send(renderUserFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      values,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      error
    }));

  if (!email) {
    return fail('L\'email est obligatoire.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
  if (password !== confirmPassword) {
    return fail('Les deux mots de passe ne correspondent pas.');
  }

  try {
    const salt = generateSalt();
    await User.create({
      email,
      salt,
      password: await hashPassword(password, salt),
      blocked,
      blockedAt: blocked ? new Date() : undefined
    });
    res.redirect('/admin/users?msg=created');
  } catch (err) {
    console.error('Erreur de création d\'utilisateur:', err);
    const described = describeError(err);
    return fail(described.message, described.status);
  }
});

router.get('/:uid/edit', async (req: Request, res: Response) => {
  try {
    const user = await User.findOne({ uid: req.params.uid });
    if (!user) {
      return res.status(404).redirect('/admin/users');
    }

    res.type('html').send(renderUserFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      uid: user.uid,
      values: { email: user.email, blocked: user.blocked },
      minPasswordLength: MIN_PASSWORD_LENGTH
    }));
  } catch (err) {
    console.error('Erreur de chargement d\'utilisateur:', err);
    res.redirect('/admin/users');
  }
});

router.post('/:uid/edit', async (req: Request, res: Response) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirmPassword || '');
  const blocked = req.body.blocked === 'true';

  const fail = (error: string, status = 400) =>
    res.status(status).type('html').send(renderUserFormPage({
      username: adminName(req),
      csrf: csrfToken(req),
      uid: req.params.uid,
      values: { email, blocked },
      minPasswordLength: MIN_PASSWORD_LENGTH,
      error
    }));

  if (!email) {
    return fail('L\'email est obligatoire.');
  }
  // Mot de passe optionnel en modification : vide = inchangé.
  if (password || confirmPassword) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return fail(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
    }
    if (password !== confirmPassword) {
      return fail('Les deux mots de passe ne correspondent pas.');
    }
  }

  try {
    const user = await User.findOne({ uid: req.params.uid });
    if (!user) {
      return res.status(404).redirect('/admin/users');
    }

    user.email = email;
    if (password) {
      user.salt = generateSalt();
      user.password = await hashPassword(password, user.salt);
    }
    if (user.blocked !== blocked) {
      user.blocked = blocked;
      user.blockedAt = blocked ? new Date() : undefined;
    }

    await user.save();
    res.redirect('/admin/users?msg=updated');
  } catch (err) {
    console.error('Erreur de mise à jour d\'utilisateur:', err);
    const described = describeError(err);
    return fail(described.message, described.status);
  }
});

/**
 * Blocage / déblocage depuis la liste.
 */
async function setBlocked(req: Request, res: Response, blocked: boolean) {
  try {
    const result = await User.updateOne(
      { uid: req.params.uid },
      blocked
        ? { $set: { blocked: true, blockedAt: new Date() } }
        : { $set: { blocked: false }, $unset: { blockedAt: '' } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).redirect('/admin/users');
    }
    res.redirect(`/admin/users?msg=${blocked ? 'blocked' : 'unblocked'}`);
  } catch (err) {
    console.error('Erreur de blocage d\'utilisateur:', err);
    res.redirect('/admin/users');
  }
}

router.post('/:uid/block', (req, res) => setBlocked(req, res, true));
router.post('/:uid/unblock', (req, res) => setBlocked(req, res, false));

export { router as adminUsersRouter };
