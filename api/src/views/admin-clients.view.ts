/**
 * Pages de gestion des clients (md_client) de la console d'administration.
 */

import { CANTONS, IClient } from '../models/client.model';
import {
  DOCUMENT_SIDES,
  DocumentSide,
  IIdentityDocument,
  SIDE_LABELS
} from '../models/identity-document.model';
import {
  alertBlock,
  consolePage,
  csrfField,
  escapeHtml,
  formatDate,
  PageInfo,
  renderPagination,
  statusBadge,
  toDateInputValue
} from './layout';

/** Utilisateur proposé comme titulaire d'un dossier client. */
export interface UserOption {
  uid: string;
  email: string;
  blocked: boolean;
}

const SEXES: Array<{ value: string; label: string }> = [
  { value: 'M', label: 'Masculin' },
  { value: 'F', label: 'Féminin' },
  { value: 'X', label: 'Autre' }
];

export interface ClientListOptions {
  username: string;
  clients: IClient[];
  /** Email du titulaire, par uid — les clients ne portent qu'un userUid. */
  userEmails: Map<string, string>;
  /** Faces de pièce d'identité déposées, par uid de client. */
  documents: Map<string, DocumentSide[]>;
  search: string;
  userUid: string;
  csrf: string;
  page: PageInfo;
  error?: string;
  notice?: string;
}

/**
 * État du dossier d'identité : c'est lui qui décide si une lettre de
 * résiliation peut partir, la caisse exigeant une copie des deux faces.
 */
function documentBadge(sides: DocumentSide[] = []): string {
  if (sides.length >= 2) {
    return '<span class="badge ok">Recto + verso</span>';
  }
  if (sides.length === 1) {
    return `<span class="badge">${escapeHtml(SIDE_LABELS[sides[0]])} seul</span>`;
  }
  return '<span class="badge blocked">Aucune</span>';
}

export function renderClientListPage(options: ClientListOptions): string {
  const filterNotice = options.userUid
    ? `Filtré sur l'utilisateur ${options.userEmails.get(options.userUid) || options.userUid}.`
    : undefined;

  const body = options.clients.length === 0
    ? `    <p class="empty">Aucun client${options.search || options.userUid ? ' ne correspond à ce filtre' : ''}.</p>`
    : `    <table>
      <thead>
        <tr>
          <th>Nom</th>
          <th>Email</th>
          <th>Canton</th>
          <th>Naissance</th>
          <th>Pièce d'identité</th>
          <th>Titulaire</th>
          <th>Statut</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
${options.clients.map((client) => renderClientRow(client, options.userEmails, options.documents.get(client.uid) || [], options.csrf)).join('\n')}
      </tbody>
    </table>
${renderPagination(options.page)}`;

  const clearFilter = options.userUid
    ? '      <a class="muted" href="/admin/clients">Retirer le filtre</a>\n'
    : '';

  return consolePage('Helvetik — Clients', { username: options.username, active: 'clients' },
    `    <h1>Clients</h1>
${alertBlock(options.error, options.notice || filterNotice)}
    <div class="toolbar">
      <form method="get" action="/admin/clients">
        ${options.userUid ? `<input type="hidden" name="userUid" value="${escapeHtml(options.userUid)}">` : ''}
        <input name="q" type="search" value="${escapeHtml(options.search)}" placeholder="Nom, prénom, email ou n° AVS…" aria-label="Rechercher un client">
        <button type="submit">Rechercher</button>
      </form>
${clearFilter}      <a class="btn-primary" href="/admin/clients/new">Nouveau client</a>
    </div>
${body}`);
}

function renderClientRow(
  client: IClient,
  userEmails: Map<string, string>,
  sides: DocumentSide[],
  csrf: string
): string {
  const uid = escapeHtml(client.uid);
  const action = client.blocked ? 'unblock' : 'block';
  const actionLabel = client.blocked ? 'Débloquer' : 'Bloquer';
  const fullName = [client.firstname, client.name].filter(Boolean).join(' ') || 'Identité à compléter';
  const holder = userEmails.get(client.userUid);

  return `        <tr>
          <td>${escapeHtml(fullName)}</td>
          <td>${escapeHtml(client.email)}</td>
          <td>${escapeHtml(client.canton)}</td>
          <td>${formatDate(client.birthdate)}</td>
          <td>${documentBadge(sides)}${sides.length
            ? ` <a href="/admin/clients/${uid}/piece">Consulter</a>`
            : ''}</td>
          <td>${holder
            ? `<a href="/admin/clients?userUid=${escapeHtml(client.userUid)}">${escapeHtml(holder)}</a>`
            : `<span class="muted">${escapeHtml(client.userUid)}</span>`}</td>
          <td>${statusBadge(client.blocked)}</td>
          <td class="actions">
            <a href="/admin/clients/${uid}/edit">Modifier</a>
            <form method="post" action="/admin/clients/${uid}/${action}" style="display:inline"
                  data-confirm="${escapeHtml(`${actionLabel} le dossier de ${fullName} ?`)}">
              ${csrfField(csrf)}
              <button type="submit"${client.blocked ? '' : ' class="danger"'}>${actionLabel}</button>
            </form>
          </td>
        </tr>`;
}

/** Valeurs du formulaire, telles que saisies (donc toutes en chaînes). */
export interface ClientFormValues {
  userUid?: string;
  name?: string;
  firstname?: string;
  birthdate?: string;
  email?: string;
  phone?: string;
  road?: string;
  plz?: string;
  location?: string;
  canton?: string;
  nationality?: string;
  avsNum?: string;
  sexe?: string;
  blocked?: boolean;
}

export interface ClientFormOptions {
  username: string;
  csrf: string;
  /** Absent en création. */
  uid?: string;
  values: ClientFormValues;
  users: UserOption[];
  error?: string;
}

/** Reconstruit les valeurs du formulaire à partir d'un document existant. */
export function clientToFormValues(client: IClient): ClientFormValues {
  return {
    userUid: client.userUid,
    name: client.name,
    firstname: client.firstname,
    birthdate: toDateInputValue(client.birthdate),
    email: client.email,
    phone: client.phone,
    road: client.road,
    plz: client.plz,
    location: client.location,
    canton: client.canton,
    nationality: client.nationality,
    avsNum: client.avsNum,
    sexe: client.sexe,
    blocked: client.blocked
  };
}

export function renderClientFormPage(options: ClientFormOptions): string {
  const isEdit = Boolean(options.uid);
  const title = isEdit ? 'Modifier le client' : 'Nouveau client';
  const action = isEdit ? `/admin/clients/${escapeHtml(options.uid!)}/edit` : '/admin/clients/new';
  const v = options.values;

  const text = (
    id: keyof ClientFormValues,
    label: string,
    attrs = '',
    required = true
  ) => `      <div>
        <label for="${id}">${escapeHtml(label)}</label>
        <input id="${id}" name="${id}" value="${escapeHtml(String(v[id] ?? ''))}" ${attrs}${required ? ' required' : ''}>
      </div>`;

  const options_ = (list: Array<{ value: string; label: string }>, selected?: string) =>
    list
      .map((item) =>
        `<option value="${escapeHtml(item.value)}"${item.value === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`)
      .join('\n          ');

  const userOptions = options.users
    .map((user) => {
      const label = user.blocked ? `${user.email} (bloqué)` : user.email;
      return `<option value="${escapeHtml(user.uid)}"${user.uid === v.userUid ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('\n        ');

  return consolePage(`Helvetik — ${title}`, { username: options.username, active: 'clients' },
    `    <h1>${escapeHtml(title)}</h1>
${alertBlock(options.error)}
    <form class="panel" method="post" action="${action}">
      ${csrfField(options.csrf)}
      <label for="userUid">Utilisateur titulaire</label>
      <select id="userUid" name="userUid" required>
        <option value="">— Sélectionner —</option>
        ${userOptions}
      </select>

      <fieldset>
        <legend>Identité</legend>
        <p class="muted">Facultative : elle est renseignée par lecture de la pièce
        d'identité depuis l'espace de l'assuré. Sans date de naissance, la fiche est
        écartée de la comparaison de primes.</p>
        <div class="grid">
${text('firstname', 'Prénom', 'type="text" autofocus', false)}
${text('name', 'Nom', 'type="text"', false)}
${text('birthdate', 'Date de naissance', 'type="date"', false)}
          <div>
            <label for="sexe">Sexe</label>
            <select id="sexe" name="sexe">
              <option value="">— Non renseigné —</option>
              ${options_(SEXES, v.sexe)}
            </select>
          </div>
${text('nationality', 'Nationalité', 'type="text"', false)}
${text('avsNum', 'N° AVS', 'type="text" placeholder="756.1234.5678.90" pattern="756\\.\\d{4}\\.\\d{4}\\.\\d{2}"')}
        </div>
      </fieldset>

      <fieldset>
        <legend>Contact</legend>
        <div class="grid">
${text('email', 'Email', 'type="email"')}
${text('phone', 'Téléphone (facultatif)', 'type="tel"', false)}
        </div>
${text('road', 'Rue et numéro', 'type="text"')}
        <div class="grid">
${text('plz', 'NPA', 'type="text" inputmode="numeric" pattern="\\d{4}"')}
${text('location', 'Localité', 'type="text"')}
          <div>
            <label for="canton">Canton</label>
            <select id="canton" name="canton" required>
              <option value="">—</option>
              ${options_(CANTONS.map((c) => ({ value: c, label: c })), v.canton)}
            </select>
          </div>
        </div>
      </fieldset>

      <label for="blocked">Statut</label>
      <select id="blocked" name="blocked">
        <option value="false"${v.blocked ? '' : ' selected'}>Actif</option>
        <option value="true"${v.blocked ? ' selected' : ''}>Bloqué</option>
      </select>

      <div class="form-actions">
        <button type="submit">${isEdit ? 'Enregistrer' : 'Créer'}</button>
        <a href="/admin/clients">Annuler</a>
      </div>
    </form>`);
}

/**
 * Dossier d'identité d'un client, tel que la console le présente.
 *
 * Les fichiers ne sont pas affichés ici : ils sont téléchargés à la demande,
 * et chaque téléchargement laisse une trace. Cette page sert à savoir ce dont
 * on dispose avant de préparer une lettre — pas à feuilleter des cartes
 * d'identité.
 */
export function renderClientDocumentsPage(options: {
  username: string;
  client: IClient;
  holderEmail?: string;
  documents: IIdentityDocument[];
}): string {
  const client = options.client;
  const fullName = [client.firstname, client.name].filter(Boolean).join(' ') || client.email;
  const byside = new Map(options.documents.map((d) => [d.side, d]));

  const row = (side: DocumentSide) => {
    const document = byside.get(side);
    const label = SIDE_LABELS[side];

    if (!document) {
      return `        <tr>
          <td><strong>${escapeHtml(label)}</strong></td>
          <td colspan="4"><span class="badge blocked">Non déposé</span></td>
        </tr>`;
    }

    const lastAccess = document.lastAccessedAt
      ? `${formatDate(document.lastAccessedAt)} (${document.accessCount} accès)`
      : 'jamais consulté';

    return `        <tr>
          <td><strong>${escapeHtml(label)}</strong></td>
          <td>${escapeHtml(document.filename)}<br>
            <span class="muted">${escapeHtml(document.mimetype)} — ${Math.round(document.size / 1024)} Ko</span></td>
          <td>${formatDate(document.uploadedAt)}</td>
          <td>${escapeHtml(lastAccess)}</td>
          <td class="actions">
            <a href="/admin/clients/${escapeHtml(client.uid)}/piece/${side.toLowerCase()}">Télécharger</a>
          </td>
        </tr>`;
  };

  const complete = options.documents.length >= 2;

  return consolePage('Helvetik — Pièce d\'identité', { username: options.username, active: 'clients' },
    `    <h1>Pièce d'identité — ${escapeHtml(fullName)}</h1>
${alertBlock(
      complete ? undefined : 'Dossier incomplet : une lettre de résiliation sans copie des deux faces sera refusée par la caisse.',
      complete ? 'Recto et verso disponibles : le dossier peut accompagner une lettre.' : undefined
    )}
    <p class="muted">Titulaire : ${escapeHtml(options.holderEmail || client.userUid)} —
    ${escapeHtml(client.road)}, ${escapeHtml(client.plz)} ${escapeHtml(client.location)}
    (${escapeHtml(client.canton)})</p>
    <table>
      <thead>
        <tr>
          <th>Face</th>
          <th>Fichier</th>
          <th>Déposé le</th>
          <th>Dernier accès</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
${DOCUMENT_SIDES.map(row).join('\n')}
      </tbody>
    </table>
    <p class="muted">Chaque téléchargement est journalisé. Les fichiers sont conservés
    chiffrés ; seul l'assuré peut les remplacer ou les supprimer, depuis son espace.</p>
    <div class="toolbar"><a class="muted" href="/admin/clients">Retour aux clients</a></div>`);
}
