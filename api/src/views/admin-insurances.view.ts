/**
 * Pages de gestion des assurances (md_insurance) de la console d'administration.
 */

import {
  IInsurance,
  INSURANCE_STATUSES,
  INSURANCE_TYPES,
  PREMIUM_FREQUENCIES,
  TARIFF_TYPES,
  TARIFF_TYPE_LABELS
} from '../models/insurance.model';
import { monthlyPremium } from '../utils/insurance-payload';
import {
  alertBlock,
  consolePage,
  csrfField,
  escapeHtml,
  formatDate,
  PageInfo,
  renderPagination,
  toDateInputValue
} from './layout';

/** Libellés lisibles des énumérations, l'anglais technique restant en base. */
const TYPE_LABELS: Record<string, string> = {
  LAMAL: 'LAMal (base)',
  COMPLEMENTAIRE_SANTE: 'Complémentaire santé',
  ACCIDENT: 'Accident',
  INDEMNITE_JOURNALIERE: 'Indemnité journalière',
  VIE: 'Vie / 3e pilier',
  RC_PRIVEE: 'RC privée',
  MENAGE: 'Ménage',
  BATIMENT: 'Bâtiment',
  VEHICULE: 'Véhicule',
  PROTECTION_JURIDIQUE: 'Protection juridique',
  VOYAGE: 'Voyage',
  ANIMAUX: 'Animaux',
  AUTRE: 'Autre'
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'En vigueur',
  PENDING: 'À venir',
  EXPIRED: 'Échue',
  CANCELLED: 'Résiliée'
};

const FREQUENCY_LABELS: Record<string, string> = {
  MENSUEL: 'Mensuel',
  TRIMESTRIEL: 'Trimestriel',
  SEMESTRIEL: 'Semestriel',
  ANNUEL: 'Annuel'
};

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] || type;
}

/** Assuré proposé dans le formulaire, avec son titulaire pour lever l'ambiguïté des homonymes. */
export interface ClientOption {
  uid: string;
  /** Peuvent manquer : l'identité est saisie après la création du compte. */
  name?: string;
  firstname?: string;
  userEmail?: string;
}

/** Libellé d'un assuré, tolérant à une identité incomplète. */
export function clientLabel(client: { firstname?: string; name?: string; uid?: string }): string {
  const full = [client.firstname, client.name].filter(Boolean).join(' ').trim();
  return full || 'Identité à compléter';
}

function statusChip(status: string): string {
  const kind = status === 'ACTIVE' ? 'ok' : status === 'CANCELLED' || status === 'EXPIRED' ? 'blocked' : '';
  return `<span class="badge ${kind}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
}

function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${escapeHtml(currency)}`;
}

export interface InsuranceListOptions {
  username: string;
  insurances: IInsurance[];
  /** Assuré par uid — les contrats ne portent qu'un clientUid. */
  clients: Map<string, ClientOption>;
  search: string;
  type: string;
  status: string;
  clientUid: string;
  csrf: string;
  page: PageInfo;
  /** Total des primes ramenées au mois, sur l'ensemble du filtre. */
  monthlyTotal: number;
  error?: string;
  notice?: string;
}

export function renderInsuranceListPage(options: InsuranceListOptions): string {
  const selected = (value: string, current: string) =>
    value === current ? ' selected' : '';

  const typeOptions = INSURANCE_TYPES
    .map((t) => `<option value="${t}"${selected(t, options.type)}>${escapeHtml(typeLabel(t))}</option>`)
    .join('\n          ');

  const statusOptions = INSURANCE_STATUSES
    .map((s) => `<option value="${s}"${selected(s, options.status)}>${escapeHtml(STATUS_LABELS[s])}</option>`)
    .join('\n          ');

  const insuredFilter = options.clientUid
    ? `Filtré sur l'assuré ${describeClient(options.clients.get(options.clientUid), options.clientUid)}.`
    : undefined;

  const body = options.insurances.length === 0
    ? `    <p class="empty">Aucune assurance${options.search || options.type || options.status || options.clientUid ? ' ne correspond à ce filtre' : ''}.</p>`
    : `    <table>
      <thead>
        <tr>
          <th>Prestataire / offre</th>
          <th>Type</th>
          <th>Assuré</th>
          <th>N° police</th>
          <th>Période</th>
          <th>Prime</th>
          <th>Statut</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
${options.insurances.map((insurance) => renderInsuranceRow(insurance, options.clients, options.csrf)).join('\n')}
      </tbody>
    </table>
${renderPagination(options.page)}`;

  const clearFilter = options.clientUid
    ? '      <a class="muted" href="/admin/insurances">Retirer le filtre</a>\n'
    : '';

  return consolePage('Helvetik — Assurances', { username: options.username, active: 'insurances' },
    `    <h1>Assurances</h1>
${alertBlock(options.error, options.notice || insuredFilter)}
    <div class="toolbar">
      <form method="get" action="/admin/insurances">
        ${options.clientUid ? `<input type="hidden" name="clientUid" value="${escapeHtml(options.clientUid)}">` : ''}
        <input name="q" type="search" value="${escapeHtml(options.search)}" placeholder="Prestataire, offre ou n° de police…" aria-label="Rechercher une assurance">
        <select name="type" aria-label="Type d'assurance">
          <option value="">Tous les types</option>
          ${typeOptions}
        </select>
        <select name="status" aria-label="Statut">
          <option value="">Tous les statuts</option>
          ${statusOptions}
        </select>
        <button type="submit">Filtrer</button>
      </form>
${clearFilter}      <a class="btn-primary" href="/admin/insurances/new">Nouvelle assurance</a>
    </div>
    <p class="muted">${options.page.total} contrat(s) — ${money(options.monthlyTotal, 'CHF')} par mois au total.</p>
${body}`);
}

function describeClient(client: ClientOption | undefined, fallbackUid: string): string {
  if (!client) {
    return escapeHtml(fallbackUid);
  }
  return escapeHtml(clientLabel(client));
}

function renderInsuranceRow(
  insurance: IInsurance,
  clients: Map<string, ClientOption>,
  csrf: string
): string {
  const uid = escapeHtml(insurance.uid);
  const client = clients.get(insurance.clientUid);
  const insuredName = client ? clientLabel(client) : insurance.clientUid;
  const renewal = insurance.autoRenew ? ' <span class="muted">(tacite)</span>' : '';
  const period = `${formatDate(insurance.startDate)} → ${formatDate(insurance.endDate)}${renewal}`;

  return `        <tr>
          <td>
            <strong>${escapeHtml(insurance.provider)}</strong><br>
            <span class="muted">${escapeHtml(insurance.productName)}</span>
          </td>
          <td>${escapeHtml(typeLabel(insurance.type))}</td>
          <td><a href="/admin/insurances?clientUid=${escapeHtml(insurance.clientUid)}">${escapeHtml(insuredName)}</a></td>
          <td>${escapeHtml(insurance.policyNumber)}</td>
          <td>${period}</td>
          <td>
            ${money(insurance.premiumAmount, insurance.currency)}<br>
            <span class="muted">${escapeHtml(FREQUENCY_LABELS[insurance.premiumFrequency] || insurance.premiumFrequency)} — ${money(monthlyPremium(insurance.premiumAmount, insurance.premiumFrequency), insurance.currency)}/mois</span>
          </td>
          <td>${statusChip(insurance.status)}</td>
          <td class="actions">
            <a href="/admin/insurances/${uid}/edit">Modifier</a>
            <form method="post" action="/admin/insurances/${uid}/delete" style="display:inline"
                  data-confirm="${escapeHtml(`Supprimer définitivement le contrat ${insurance.provider} — ${insurance.productName} de ${insuredName} ?`)}">
              ${csrfField(csrf)}
              <button type="submit" class="danger">Supprimer</button>
            </form>
          </td>
        </tr>`;
}

/** Valeurs du formulaire, telles que saisies (donc toutes en chaînes). */
export interface InsuranceFormValues {
  clientUid?: string;
  provider?: string;
  productName?: string;
  type?: string;
  description?: string;
  policyNumber?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  premiumAmount?: string;
  premiumFrequency?: string;
  currency?: string;
  franchise?: string;
  coverageAmount?: string;
  cancellationNoticeMonths?: string;
  autoRenew?: boolean;
  employerAccidentCoverage?: boolean;
  tariffType?: string;
  tariffCode?: string;
  notes?: string;
}

export interface InsuranceFormOptions {
  username: string;
  csrf: string;
  /** Absent en création. */
  uid?: string;
  values: InsuranceFormValues;
  clients: ClientOption[];
  error?: string;
}

/** Reconstruit les valeurs du formulaire à partir d'un document existant. */
export function insuranceToFormValues(insurance: IInsurance): InsuranceFormValues {
  const num = (value?: number) => (value === undefined || value === null ? '' : String(value));

  return {
    clientUid: insurance.clientUid,
    provider: insurance.provider,
    productName: insurance.productName,
    type: insurance.type,
    description: insurance.description || '',
    policyNumber: insurance.policyNumber,
    startDate: toDateInputValue(insurance.startDate),
    endDate: toDateInputValue(insurance.endDate),
    status: insurance.status,
    premiumAmount: num(insurance.premiumAmount),
    premiumFrequency: insurance.premiumFrequency,
    currency: insurance.currency,
    franchise: num(insurance.franchise),
    coverageAmount: num(insurance.coverageAmount),
    cancellationNoticeMonths: num(insurance.cancellationNoticeMonths),
    autoRenew: insurance.autoRenew,
    employerAccidentCoverage: insurance.employerAccidentCoverage,
    tariffType: insurance.tariffType || '',
    tariffCode: insurance.tariffCode || '',
    notes: insurance.notes || ''
  };
}

export function renderInsuranceFormPage(options: InsuranceFormOptions): string {
  const isEdit = Boolean(options.uid);
  const title = isEdit ? 'Modifier l\'assurance' : 'Nouvelle assurance';
  const action = isEdit
    ? `/admin/insurances/${escapeHtml(options.uid!)}/edit`
    : '/admin/insurances/new';
  const v = options.values;

  const field = (
    id: keyof InsuranceFormValues,
    label: string,
    attrs = '',
    required = false
  ) => `      <div>
        <label for="${id}">${escapeHtml(label)}</label>
        <input id="${id}" name="${id}" value="${escapeHtml(String(v[id] ?? ''))}" ${attrs}${required ? ' required' : ''}>
      </div>`;

  const select = (
    id: string,
    label: string,
    entries: Array<{ value: string; label: string }>,
    current?: string,
    placeholder?: string
  ) => `      <div>
        <label for="${id}">${escapeHtml(label)}</label>
        <select id="${id}" name="${id}" required>
          ${placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : ''}
          ${entries
            .map((e) => `<option value="${escapeHtml(e.value)}"${e.value === current ? ' selected' : ''}>${escapeHtml(e.label)}</option>`)
            .join('\n          ')}
        </select>
      </div>`;

  const clientEntries = options.clients.map((client) => ({
    value: client.uid,
    label: client.userEmail
      ? `${clientLabel(client)} — ${client.userEmail}`
      : clientLabel(client)
  }));

  return consolePage(`Helvetik — ${title}`, { username: options.username, active: 'insurances' },
    `    <h1>${escapeHtml(title)}</h1>
${alertBlock(options.error)}
    <form class="panel" method="post" action="${action}">
      ${csrfField(options.csrf)}

      <fieldset>
        <legend>Contrat</legend>
${select('clientUid', 'Assuré', clientEntries, v.clientUid, '— Sélectionner —')}
        <div class="grid">
${field('provider', 'Prestataire', 'type="text" placeholder="Helvetia, La Baloise…" autofocus', true)}
${field('productName', 'Nom de l\'offre', 'type="text" placeholder="Primeo Basic"', true)}
${select('type', 'Type', INSURANCE_TYPES.map((t) => ({ value: t, label: typeLabel(t) })), v.type, '— Sélectionner —')}
${field('policyNumber', 'N° de police', 'type="text"', true)}
        </div>
        <div>
          <label for="description">Description</label>
          <input id="description" name="description" type="text" value="${escapeHtml(v.description ?? '')}">
        </div>
      </fieldset>

      <fieldset>
        <legend>Durée</legend>
        <div class="grid">
${field('startDate', 'Date de début', 'type="date"', true)}
${field('endDate', 'Fin de la période en cours', 'type="date"', true)}
${select('status', 'Statut', INSURANCE_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })), v.status)}
${field('cancellationNoticeMonths', 'Préavis de résiliation (mois)', 'type="number" min="0" max="24" step="1"')}
        </div>
        <p class="muted">Sur un contrat à reconduction tacite, indiquer le terme de la période
        en cours (31.12 pour une LAMal, date anniversaire ailleurs) et laisser « Reconduction
        tacite » à Oui. Le préavis en sert à calculer l'échéance de résiliation.</p>
      </fieldset>

      <fieldset>
        <legend>Montants</legend>
        <div class="grid">
${field('premiumAmount', 'Prime', 'type="number" min="0" step="0.05"', true)}
${select('premiumFrequency', 'Périodicité', PREMIUM_FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABELS[f] })), v.premiumFrequency)}
${field('currency', 'Devise', 'type="text" maxlength="3"')}
${field('franchise', 'Franchise', 'type="number" min="0" step="1"')}
${field('coverageAmount', 'Somme assurée', 'type="number" min="0" step="1"')}
        </div>
      </fieldset>

      <div class="grid">
        <div>
          <label for="autoRenew">Reconduction tacite</label>
          <select id="autoRenew" name="autoRenew">
            <option value="true"${v.autoRenew === false ? '' : ' selected'}>Oui</option>
            <option value="false"${v.autoRenew === false ? ' selected' : ''}>Non</option>
          </select>
        </div>
        <div>
          <label for="employerAccidentCoverage">Accidents couverts par l'employeur</label>
          <select id="employerAccidentCoverage" name="employerAccidentCoverage">
            <option value="false"${v.employerAccidentCoverage ? '' : ' selected'}>Non — couverture accident incluse dans la LAMal</option>
            <option value="true"${v.employerAccidentCoverage ? ' selected' : ''}>Oui — couverture accident retirée de la LAMal</option>
          </select>
        </div>
      </div>
      <p class="muted">La couverture accident ne concerne que la LAMal. Une personne employée
      plus de 8 h par semaine est assurée par son employeur et fait retirer cette couverture,
      ce qui réduit sa prime.</p>

      <fieldset>
        <legend>Modèle LAMal</legend>
        <div class="grid">
          <div>
            <label for="tariffType">Modèle</label>
            <select id="tariffType" name="tariffType">
              <option value=""${v.tariffType ? '' : ' selected'}>— Non renseigné —</option>
              ${TARIFF_TYPES
                .map((t) => `<option value="${t}"${t === v.tariffType ? ' selected' : ''}>${escapeHtml(TARIFF_TYPE_LABELS[t])}</option>`)
                .join('\n              ')}
            </select>
          </div>
${field('tariffCode', 'Code de l\'offre (OFSP)', 'type="text" placeholder="01_016"')}
        </div>
        <p class="muted">Réservé aux contrats LAMal. Sans ces champs, la comparaison de primes
        prend le modèle standard comme référence et sous-estime l'économie des assurés déjà
        sur un modèle alternatif. Les codes disponibles se lisent sur la page des primes
        officielles, ou via <code>/api/comparison/lamal-models</code>.</p>
      </fieldset>

      <div>
        <label for="notes">Notes</label>
        <input id="notes" name="notes" type="text" value="${escapeHtml(v.notes ?? '')}">
      </div>

      <div class="form-actions">
        <button type="submit">${isEdit ? 'Enregistrer' : 'Créer'}</button>
        <a href="/admin/insurances">Annuler</a>
      </div>
    </form>`);
}
