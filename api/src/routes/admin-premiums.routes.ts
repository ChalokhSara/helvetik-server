import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { tmpdir } from 'os';
import { unlink } from 'fs/promises';
import { PremiumYear } from '../models/premium.model';
import { csrfToken, isCsrfValid, CSRF_REJECTION_MESSAGE } from '../utils/csrf';
import { activateYear, deleteYear, importWorkbook } from '../services/premium-import.service';
import { syncPremiumsFromOfsp } from '../services/premium-download.service';
import { renderPremiumsPage } from '../views/admin-premiums.view';

const router = Router();

/** Le répertoire complet pèse 15 Mo ; on laisse de la marge sans plus. */
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
});

function adminName(req: Request): string {
  return req.session.adminUsername || '';
}

async function render(
  req: Request,
  res: Response,
  extra: { error?: string; notice?: string } = {},
  status = 200
): Promise<void> {
  const years = await PremiumYear.find().sort({ year: -1 });
  res.status(status).type('html').send(renderPremiumsPage({
    username: adminName(req),
    years,
    csrf: csrfToken(req),
    ...extra
  }));
}

const NOTICES: Record<string, string> = {
  activated: 'Année mise en service.',
  deleted: 'Année supprimée.',
  redistribution: 'Redistribution enregistrée.'
};

router.get('/', async (req: Request, res: Response) => {
  try {
    await render(req, res, { notice: NOTICES[String(req.query.msg || '')] });
  } catch (err) {
    console.error('Erreur de chargement des primes:', err);
    res.status(500).type('html').send('Erreur serveur.');
  }
});

/**
 * Dépôt manuel d'un fichier de l'OFSP. Le type est déduit de sa structure,
 * l'administrateur n'a donc pas à préciser lequel des trois il dépose.
 */
/**
 * Vérification CSRF après multer, une fois le corps multipart analysé.
 * En cas de rejet, le fichier temporaire déjà écrit est effacé.
 */
async function verifyUploadCsrf(req: Request, res: Response, next: NextFunction) {
  if (isCsrfValid(req)) {
    return next();
  }
  if (req.file) {
    await unlink(req.file.path).catch(() => undefined);
  }
  res.status(403).type('text/plain').send(CSRF_REJECTION_MESSAGE);
}

router.post('/upload', upload.single('file'), verifyUploadCsrf, async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    return render(req, res, { error: 'Aucun fichier reçu.' }, 400);
  }

  if (!/\.xlsx$/i.test(file.originalname)) {
    await unlink(file.path).catch(() => undefined);
    return render(req, res, { error: 'Seuls les fichiers .xlsx de l\'OFSP sont acceptés.' }, 400);
  }

  try {
    const result = await importWorkbook(file.path, {
      filename: file.originalname,
      origin: 'UPLOAD',
      importedBy: adminName(req),
      replaceActive: req.body?.replaceActive === 'true'
    });
    await render(req, res, { notice: result.message });
  } catch (err) {
    console.error('Erreur d\'import de primes:', err);
    await render(req, res, { error: (err as Error).message }, 400);
  }
});

/** Téléchargement direct depuis priminfo.admin.ch. */
router.post('/sync', async (req: Request, res: Response) => {
  try {
    const outcome = await syncPremiumsFromOfsp({
      importedBy: adminName(req),
      replaceActive: false
    });

    const lines = [
      ...outcome.results.map((r) => r.message),
      ...outcome.skipped,
      ...outcome.errors.map((e) => `Échec — ${e}`)
    ];

    await render(req, res, outcome.errors.length
      ? { error: lines.join(' ') }
      : { notice: lines.join(' ') || 'Rien de neuf chez l\'OFSP.' });
  } catch (err) {
    console.error('Erreur de synchronisation des primes:', err);
    await render(req, res, { error: (err as Error).message }, 500);
  }
});

router.post('/:year/activate', async (req: Request, res: Response) => {
  try {
    await activateYear(Number(req.params.year));
    res.redirect('/admin/premiums?msg=activated');
  } catch (err) {
    await render(req, res, { error: (err as Error).message }, 400);
  }
});

router.post('/:year/delete', async (req: Request, res: Response) => {
  try {
    await deleteYear(Number(req.params.year));
    res.redirect('/admin/premiums?msg=deleted');
  } catch (err) {
    await render(req, res, { error: (err as Error).message }, 400);
  }
});

/**
 * La redistribution de la taxe environnementale n'est pas dans les fichiers de
 * l'OFSP : elle est fixée chaque année séparément et se saisit ici.
 */
router.post('/:year/redistribution', async (req: Request, res: Response) => {
  const value = Number(String(req.body?.redistributionYearly ?? '').replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) {
    return render(req, res, { error: 'La redistribution doit être un montant positif.' }, 400);
  }

  try {
    const year = await PremiumYear.findOne({ year: Number(req.params.year) });
    if (!year) {
      return render(req, res, { error: 'Année inconnue.' }, 404);
    }
    year.redistributionYearly = value;
    await year.save();
    res.redirect('/admin/premiums?msg=redistribution');
  } catch (err) {
    console.error('Erreur d\'enregistrement de la redistribution:', err);
    await render(req, res, { error: 'Erreur serveur.' }, 500);
  }
});

export { router as adminPremiumsRouter };
