/**
 * Retours des assurés (md_feedback) dans la console d'administration.
 *
 * Le questionnaire conditionne l'accès aux lettres de changement de caisse :
 * tous ceux qui vont au bout du parcours y répondent. C'est donc le seul
 * endroit où l'on apprend ce que les gens attendent du service, et il ne
 * servait à rien tant que personne ne pouvait le lire.
 *
 * La page est faite pour être parcourue, pas seulement consultée : la synthèse
 * en tête donne la tendance, la liste en dessous donne les mots. Ce sont les
 * commentaires qui apprennent quelque chose, ils ne sont donc pas tronqués.
 */

import { IFeedback, INTEREST_LABELS, InterestLevel } from '../models/feedback.model';
import {
  alertBlock,
  consolePage,
  escapeHtml,
  formatDate,
  PageInfo,
  renderPagination
} from './layout';

/** Synthèse affichée en tête : la tendance avant le détail. */
export interface FeedbackSummary {
  total: number;
  /** Répartition par niveau d'intérêt. */
  byInterest: Record<InterestLevel, number>;
  /** Note moyenne d'expérience, sur les réponses qui en portent une. */
  averageRating: number | null;
  ratedCount: number;
  betaTesters: number;
  recontactable: number;
  /** Économie mensuelle moyenne affichée au moment des réponses. */
  averageShownSavings: number | null;
}

export interface FeedbackListOptions {
  username: string;
  entries: IFeedback[];
  summary: FeedbackSummary;
  /** Filtre actif sur le niveau d'intérêt. */
  interest: string;
  /** Restreint aux bêta-testeurs, ou à ceux qui acceptent d'être recontactés. */
  flag: string;
  search: string;
  page: PageInfo;
  notice?: string;
  error?: string;
}

const FLAG_LABELS: Record<string, string> = {
  beta: 'Bêta-testeurs',
  recontact: 'Acceptent d\'être recontactés',
  commented: 'Ont laissé un commentaire'
};

function money(value: number): string {
  return `${value.toFixed(2)} CHF`;
}

/** Note sur cinq, en pastilles : plus lisible qu'un nombre dans un tableau. */
function stars(rating?: number): string {
  if (!rating) {
    return '<span class="muted">—</span>';
  }
  return `<span title="${rating}/5">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>`;
}

function interestChip(interest: InterestLevel): string {
  const kind = interest === 'OUI' ? 'ok' : interest === 'NON' ? 'blocked' : '';
  const short = interest === 'OUI' ? 'Oui' : interest === 'NON' ? 'Non' : 'Peut-être';
  return `<span class="badge ${kind}">${short}</span>`;
}

function summaryBlock(summary: FeedbackSummary): string {
  if (!summary.total) {
    return '';
  }

  const share = (count: number) => `${Math.round((count / summary.total) * 100)} %`;

  return `    <div class="stats">
      <div class="stat">
        <span class="value">${summary.total}</span>
        <span class="label">réponse(s)</span>
      </div>
      <div class="stat">
        <span class="value">${share(summary.byInterest.OUI)}</span>
        <span class="label">intéressés (${summary.byInterest.OUI})</span>
      </div>
      <div class="stat">
        <span class="value">${summary.averageRating !== null
          ? summary.averageRating.toFixed(1) + '/5'
          : '—'}</span>
        <span class="label">note moyenne${summary.ratedCount
          ? ` (${summary.ratedCount} avis)`
          : ''}</span>
      </div>
      <div class="stat">
        <span class="value">${summary.betaTesters}</span>
        <span class="label">bêta-testeur(s)</span>
      </div>
    </div>
    <p class="muted">${summary.byInterest.PEUT_ETRE} « peut-être », ${summary.byInterest.NON}
    « non ». ${summary.recontactable} accepte(nt) d'être recontacté(s).${
    summary.averageShownSavings !== null
      ? ` Économie moyenne affichée au moment de la réponse : ${money(summary.averageShownSavings)} par mois.`
      : ''}</p>`;
}

/**
 * Une réponse, en bloc plutôt qu'en ligne de tableau.
 *
 * Un commentaire libre ne tient pas dans une cellule : le tronquer reviendrait
 * à jeter la seule information que ce questionnaire produit vraiment.
 */
function entryBlock(entry: IFeedback): string {
  const details: string[] = [];

  if (entry.priceExpectation) {
    details.push(`<strong>Prix acceptable :</strong> ${escapeHtml(entry.priceExpectation)}`);
  }
  if (entry.shownSavingsMonthly !== undefined && entry.shownSavingsMonthly !== null) {
    details.push(
      `<strong>Économie affichée :</strong> ${money(entry.shownSavingsMonthly)}/mois` +
      (entry.shownStrategy
        ? ` (${entry.shownStrategy === 'INDIVIDUAL' ? 'chacun sa caisse' : 'caisse commune'})`
        : '')
    );
  }
  if (entry.betaTester) {
    details.push('<span class="badge ok">Bêta-testeur</span>');
  }
  if (entry.recontact) {
    details.push(`<span class="badge">Recontact accepté</span>${
      entry.contactPhone ? ` ${escapeHtml(entry.contactPhone)}` : ''}`);
  }

  const comments = [
    entry.experienceComment ? { title: 'Expérience', text: entry.experienceComment } : null,
    entry.improvements ? { title: 'À améliorer', text: entry.improvements } : null
  ].filter(Boolean) as Array<{ title: string; text: string }>;

  return `      <article class="feedback">
        <header>
          <span>${interestChip(entry.interest)} ${escapeHtml(INTEREST_LABELS[entry.interest])}</span>
          <span class="rating">${stars(entry.experienceRating)}</span>
        </header>
        <p class="who">
          <a href="/admin/clients?userUid=${escapeHtml(entry.userUid)}">${escapeHtml(entry.email)}</a>
          <span class="muted">— ${formatDate(entry.createdAt)}</span>
        </p>
        ${details.length ? `<p class="meta">${details.join(' · ')}</p>` : ''}
${comments.map((c) => `        <blockquote>
          <span class="label">${escapeHtml(c.title)}</span>
          ${escapeHtml(c.text)}
        </blockquote>`).join('\n')}
      </article>`;
}

export function renderFeedbackPage(options: FeedbackListOptions): string {
  const selected = (value: string, current: string) =>
    value === current ? ' selected' : '';

  const interestOptions = (Object.keys(INTEREST_LABELS) as InterestLevel[])
    .map((level) =>
      `<option value="${level}"${selected(level, options.interest)}>${escapeHtml(INTEREST_LABELS[level])}</option>`)
    .join('\n          ');

  const flagOptions = Object.entries(FLAG_LABELS)
    .map(([value, label]) =>
      `<option value="${value}"${selected(value, options.flag)}>${escapeHtml(label)}</option>`)
    .join('\n          ');

  const body = options.entries.length === 0
    ? `    <p class="empty">Aucun retour${
      options.interest || options.flag || options.search ? ' ne correspond à ce filtre' : ' pour l\'instant'}.</p>`
    : `    <div class="feedback-list">
${options.entries.map(entryBlock).join('\n')}
    </div>
${renderPagination(options.page)}`;

  // L'export reprend les filtres en cours : on exporte ce que l'on regarde.
  const exportUrl = `/admin/feedback/export${options.page.baseUrl.includes('?')
    ? options.page.baseUrl.slice(options.page.baseUrl.indexOf('?'))
    : ''}`;

  return consolePage('Helvetik — Retours', { username: options.username, active: 'feedback' },
    `    <h1>Retours des assurés</h1>
${alertBlock(options.error, options.notice)}
${summaryBlock(options.summary)}
    <div class="toolbar">
      <form method="get" action="/admin/feedback">
        <input name="q" type="search" value="${escapeHtml(options.search)}"
               placeholder="Email ou mot du commentaire…" aria-label="Rechercher un retour">
        <select name="interest" aria-label="Niveau d'intérêt">
          <option value="">Tous les avis</option>
          ${interestOptions}
        </select>
        <select name="flag" aria-label="Filtre">
          <option value="">Sans filtre</option>
          ${flagOptions}
        </select>
        <button type="submit">Filtrer</button>
      </form>
      <a class="muted" href="${escapeHtml(exportUrl)}">Exporter en CSV</a>
    </div>
${body}
    <p class="muted">Le questionnaire précède la production des lettres de changement de
    caisse : chaque assuré qui va au bout du parcours y répond une fois, et peut ensuite
    modifier ses réponses.</p>`);
}
