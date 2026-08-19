import express, { Router, Request, Response, NextFunction } from 'express';
import { Admin } from '../models/admin.model';
import { User } from '../models/user.model';
import { Client } from '../models/client.model';
import { Insurance } from '../models/insurance.model';
import { generateSalt, hashPassword, verifyPassword } from '../utils/password';
import { csrfToken, verifyCsrf } from '../utils/csrf';
import {
  renderLoginPage,
  renderChangePasswordPage,
  renderDashboardPage
} from '../views/admin-login.view';
import { adminUsersRouter } from './admin-users.routes';
import { adminClientsRouter } from './admin-clients.routes';
import { adminInsurancesRouter } from './admin-insurances.routes';
import { adminPremiumsRouter } from './admin-premiums.routes';
import { adminSettingsRouter } from './admin-settings.routes';
import { adminFeedbackRouter } from './admin-feedback.routes';

const router = Router();

const MIN_PASSWORD_LENGTH = 8;

// Le formulaire de login poste en urlencoded, pas en JSON.
router.use(express.urlencoded({ extended: false }));
// Toute mutation doit porter le jeton de session (cf. utils/csrf). Les envois
// multipart font exception ici : leur corps n'est pas encore analysé à ce
// stade, la vérification a lieu après multer, dans la route concernée.
router.use((req: Request, res: Response, next: NextFunction) =>
  req.is('multipart/form-data') ? next() : verifyCsrf(req, res, next));

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.adminUid) {
    return res.redirect('/admin/login');
  }
  // Tant que le mot de passe par défaut n'est pas remplacé, seule la page
  // de changement de mot de passe est accessible.
  if (req.session.mustChangePassword && req.path !== '/password') {
    return res.redirect('/admin/password');
  }
  next();
}

/**
 * Page de login (HTML, console desktop).
 */
router.get('/login', (req, res) => {
  if (req.session.adminUid) {
    return res.redirect('/admin');
  }
  res.type('html').send(renderLoginPage({ csrf: csrfToken(req) }));
});

router.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  // Message unique en cas d'échec : ne pas révéler si le compte existe.
  const fail = () =>
    res
      .status(401)
      .type('html')
      .send(renderLoginPage({ error: 'Identifiants invalides.', username, csrf: csrfToken(req) }));

  try {
    const admin = await Admin.findOne({ username }).select('+password +salt');
    if (!admin) {
      return fail();
    }

    const valid = await verifyPassword(password, admin.salt, admin.password);
    if (!valid) {
      return fail();
    }

    req.session.adminUid = admin.uid;
    req.session.adminUsername = admin.username;
    req.session.mustChangePassword = admin.mustChangePassword;

    res.redirect(admin.mustChangePassword ? '/admin/password' : '/admin');
  } catch (err) {
    console.error('Erreur de login admin:', err);
    res.status(500).type('html').send(
      renderLoginPage({ error: 'Erreur serveur.', username, csrf: csrfToken(req) })
    );
  }
});

/**
 * Changement de mot de passe. Imposé au premier login du super admin,
 * accessible librement ensuite.
 */
router.get('/password', requireAdmin, (req, res) => {
  res.type('html').send(
    renderChangePasswordPage({
      forced: req.session.mustChangePassword,
      minLength: MIN_PASSWORD_LENGTH,
      csrf: csrfToken(req)
    })
  );
});

router.post('/password', requireAdmin, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const confirmPassword = String(req.body.confirmPassword || '');

  const fail = (error: string, status = 400) =>
    res.status(status).type('html').send(
      renderChangePasswordPage({
        error,
        forced: req.session.mustChangePassword,
        minLength: MIN_PASSWORD_LENGTH,
        csrf: csrfToken(req)
      })
    );

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return fail(`Le nouveau mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
  if (newPassword !== confirmPassword) {
    return fail('Les deux mots de passe ne correspondent pas.');
  }
  if (newPassword === currentPassword) {
    return fail('Le nouveau mot de passe doit être différent de l\'actuel.');
  }

  try {
    const admin = await Admin.findOne({ uid: req.session.adminUid }).select('+password +salt');
    if (!admin) {
      return req.session.destroy(() => res.redirect('/admin/login'));
    }

    const valid = await verifyPassword(currentPassword, admin.salt, admin.password);
    if (!valid) {
      return fail('Mot de passe actuel incorrect.', 401);
    }

    const salt = generateSalt();
    admin.salt = salt;
    admin.password = await hashPassword(newPassword, salt);
    admin.mustChangePassword = false;
    await admin.save();

    req.session.mustChangePassword = false;
    res.redirect('/admin');
  } catch (err) {
    console.error('Erreur de changement de mot de passe admin:', err);
    return fail('Erreur serveur.', 500);
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.get('/', requireAdmin, async (req, res) => {
  const username = req.session.adminUsername || '';

  try {
    const [users, blockedUsers, clients, blockedClients, insurances, activeInsurances] =
      await Promise.all([
        User.estimatedDocumentCount(),
        User.countDocuments({ blocked: true }),
        Client.estimatedDocumentCount(),
        Client.countDocuments({ blocked: true }),
        Insurance.estimatedDocumentCount(),
        Insurance.countDocuments({ status: 'ACTIVE' })
      ]);

    res.type('html').send(
      renderDashboardPage(username, {
        users, blockedUsers, clients, blockedClients, insurances, activeInsurances
      })
    );
  } catch (err) {
    console.error('Erreur de chargement du tableau de bord:', err);
    res.type('html').send(
      renderDashboardPage(username, {
        users: 0, blockedUsers: 0, clients: 0, blockedClients: 0,
        insurances: 0, activeInsurances: 0
      })
    );
  }
});

// Gestion des données : réservée aux admins authentifiés.
router.use('/users', requireAdmin, adminUsersRouter);
router.use('/clients', requireAdmin, adminClientsRouter);
router.use('/insurances', requireAdmin, adminInsurancesRouter);
router.use('/premiums', requireAdmin, adminPremiumsRouter);
router.use('/feedback', requireAdmin, adminFeedbackRouter);
router.use('/settings', requireAdmin, adminSettingsRouter);

export { router as adminRouter };
