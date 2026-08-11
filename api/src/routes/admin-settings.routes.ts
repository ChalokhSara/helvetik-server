import { Router, Request, Response } from 'express';
import { csrfToken } from '../utils/csrf';
import { describeSetting, resetSetting, saveSetting } from '../config/features';
import { renderSettingsPage } from '../views/admin-settings.view';

const router = Router();

const NOTICES: Record<string, string> = {
  enregistre: 'Réglage enregistré.',
  reinitialise: 'Réglage remis à la valeur de la configuration du serveur.'
};

async function render(
  req: Request,
  res: Response,
  extra: { error?: string; notice?: string } = {},
  status = 200
): Promise<void> {
  res.status(status).type('html').send(renderSettingsPage({
    username: req.session.adminUsername || '',
    csrf: csrfToken(req),
    emailConfirmation: await describeSetting('EMAIL_CONFIRMATION_REQUIRED'),
    ...extra
  }));
}

router.get('/', async (req: Request, res: Response) => {
  try {
    await render(req, res, { notice: NOTICES[String(req.query.msg || '')] });
  } catch (err) {
    console.error('Erreur de chargement des réglages:', err);
    res.status(500).type('html').send('Erreur serveur.');
  }
});

router.post('/email-confirmation', async (req: Request, res: Response) => {
  const raw = String(req.body?.value ?? '');
  if (raw !== 'true' && raw !== 'false') {
    return render(req, res, { error: 'Valeur invalide.' }, 400);
  }

  try {
    await saveSetting('EMAIL_CONFIRMATION_REQUIRED', raw === 'true', req.session.adminUsername);
    // Trace explicite : ce réglage change le parcours d'inscription de tous
    // les nouveaux comptes, il ne doit pas basculer sans laisser d'empreinte.
    console.log(
      `[réglages] confirmation d'email ${raw === 'true' ? 'exigée' : 'désactivée'} ` +
      `par ${req.session.adminUsername || 'un administrateur'}.`
    );
    res.redirect('/admin/settings?msg=enregistre');
  } catch (err) {
    console.error('Erreur d\'enregistrement du réglage:', err);
    await render(req, res, { error: 'Erreur serveur.' }, 500);
  }
});

router.post('/email-confirmation/reset', async (req: Request, res: Response) => {
  try {
    await resetSetting('EMAIL_CONFIRMATION_REQUIRED');
    res.redirect('/admin/settings?msg=reinitialise');
  } catch (err) {
    console.error('Erreur de réinitialisation du réglage:', err);
    await render(req, res, { error: 'Erreur serveur.' }, 500);
  }
});

export { router as adminSettingsRouter };
