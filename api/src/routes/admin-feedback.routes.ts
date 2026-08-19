import { Router, Request, Response } from 'express';
import { Feedback, INTEREST_LEVELS, InterestLevel } from '../models/feedback.model';
import { buildBaseUrl, escapeRegex, PAGE_SIZE, parsePage } from '../utils/query';
import {
  FeedbackSummary,
  renderFeedbackPage
} from '../views/admin-feedback.view';

/**
 * Consultation des retours du questionnaire.
 *
 * Lecture seule, et c'est délibéré : ces réponses sont des témoignages, pas
 * des données à corriger. Les modifier depuis la console reviendrait à
 * réécrire ce que quelqu'un a dit.
 */

const router = Router();

function adminName(req: Request): string {
  return req.session.adminUsername || '';
}

/** Filtre commun à la liste, à la synthèse et à l'export. */
function buildFilter(req: Request): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  const interest = String(req.query.interest || '').trim();
  if (INTEREST_LEVELS.includes(interest as InterestLevel)) {
    filter.interest = interest;
  }

  switch (String(req.query.flag || '').trim()) {
    case 'beta':
      filter.betaTester = true;
      break;
    case 'recontact':
      filter.recontact = true;
      break;
    case 'commented':
      // Un retour « commenté » est celui qui porte du texte libre : c'est là
      // que se trouve ce qu'aucune statistique ne dira.
      filter.$or = [
        { experienceComment: { $exists: true, $ne: '' } },
        { improvements: { $exists: true, $ne: '' } },
        { priceExpectation: { $exists: true, $ne: '' } }
      ];
      break;
  }

  const search = String(req.query.q || '').trim();
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    const matches = [
      { email: regex },
      { experienceComment: regex },
      { improvements: regex },
      { priceExpectation: regex }
    ];
    // Un filtre « commenté » pose déjà un $or : les combiner avec $and évite
    // que le second n'écrase le premier en silence.
    filter.$and = filter.$or ? [{ $or: filter.$or }, { $or: matches }] : [{ $or: matches }];
    delete filter.$or;
  }

  return filter;
}

/** Synthèse calculée sur le filtre courant, pas sur l'ensemble. */
async function summarise(filter: Record<string, unknown>): Promise<FeedbackSummary> {
  const entries = await Feedback.find(filter)
    .select('interest experienceRating betaTester recontact shownSavingsMonthly');

  const byInterest: Record<InterestLevel, number> = { OUI: 0, PEUT_ETRE: 0, NON: 0 };
  let ratingSum = 0;
  let ratedCount = 0;
  let savingsSum = 0;
  let savingsCount = 0;
  let betaTesters = 0;
  let recontactable = 0;

  for (const entry of entries) {
    byInterest[entry.interest] = (byInterest[entry.interest] || 0) + 1;
    if (entry.experienceRating) {
      ratingSum += entry.experienceRating;
      ratedCount++;
    }
    if (typeof entry.shownSavingsMonthly === 'number') {
      savingsSum += entry.shownSavingsMonthly;
      savingsCount++;
    }
    if (entry.betaTester) betaTesters++;
    if (entry.recontact) recontactable++;
  }

  return {
    total: entries.length,
    byInterest,
    averageRating: ratedCount ? ratingSum / ratedCount : null,
    ratedCount,
    betaTesters,
    recontactable,
    averageShownSavings: savingsCount ? savingsSum / savingsCount : null
  };
}

router.get('/', async (req: Request, res: Response) => {
  const page = parsePage(req.query.page);
  const search = String(req.query.q || '').trim();
  const interest = String(req.query.interest || '').trim();
  const flag = String(req.query.flag || '').trim();
  const filter = buildFilter(req);

  try {
    const [entries, total, summary] = await Promise.all([
      Feedback.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE),
      Feedback.countDocuments(filter),
      summarise(filter)
    ]);

    res.type('html').send(renderFeedbackPage({
      username: adminName(req),
      entries,
      summary,
      interest,
      flag,
      search,
      page: {
        page,
        pageSize: PAGE_SIZE,
        total,
        baseUrl: buildBaseUrl('/admin/feedback', { q: search, interest, flag })
      }
    }));
  } catch (err) {
    console.error('Erreur de listing des retours:', err);
    res.status(500).type('html').send(renderFeedbackPage({
      username: adminName(req),
      entries: [],
      summary: {
        total: 0,
        byInterest: { OUI: 0, PEUT_ETRE: 0, NON: 0 },
        averageRating: null,
        ratedCount: 0,
        betaTesters: 0,
        recontactable: 0,
        averageShownSavings: null
      },
      interest,
      flag,
      search,
      page: { page: 1, pageSize: PAGE_SIZE, total: 0, baseUrl: '/admin/feedback?' },
      error: 'Erreur serveur.'
    }));
  }
});

/** Échappement CSV : guillemets doublés, champ encadré s'il contient un séparateur. */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Export des retours filtrés.
 *
 * Point-virgule comme séparateur et BOM en tête : c'est ce qu'attend Excel en
 * configuration suisse, sans quoi tout atterrit dans une seule colonne et les
 * accents sont illisibles.
 */
router.get('/export', async (req: Request, res: Response) => {
  try {
    const entries = await Feedback.find(buildFilter(req)).sort({ createdAt: -1 });

    const header = [
      'date', 'email', 'interet', 'note', 'prix_acceptable', 'beta_testeur',
      'recontact', 'telephone', 'economie_affichee', 'strategie',
      'commentaire_experience', 'ameliorations'
    ];

    const lines = entries.map((entry) => [
      entry.createdAt.toISOString().slice(0, 10),
      entry.email,
      entry.interest,
      entry.experienceRating ?? '',
      entry.priceExpectation ?? '',
      entry.betaTester ? 'oui' : 'non',
      entry.recontact ? 'oui' : 'non',
      entry.contactPhone ?? '',
      entry.shownSavingsMonthly ?? '',
      entry.shownStrategy ?? '',
      entry.experienceComment ?? '',
      entry.improvements ?? ''
    ].map(csvCell).join(';'));

    const csv = `﻿${header.join(';')}\n${lines.join('\n')}\n`;
    const day = new Date().toISOString().slice(0, 10);

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="retours-helvetik-${day}.csv"`,
      'Cache-Control': 'no-store, private'
    }).send(csv);
  } catch (err) {
    console.error('Erreur d\'export des retours:', err);
    res.status(500).type('text/plain').send('L\'export n\'a pas pu être produit.');
  }
});

export { router as adminFeedbackRouter };
