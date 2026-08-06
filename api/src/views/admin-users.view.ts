/**
 * Pages de gestion des utilisateurs (md_user) de la console d'administration.
 */

import { IUser } from '../models/user.model';
import {
  alertBlock,
  consolePage,
  csrfField,
  escapeHtml,
  formatDate,
  PageInfo,
  renderPagination,
  statusBadge
} from './layout';

export interface UserRow {
  user: IUser;
  /** Nombre de clients rattachés, affiché en colonne. */
  clientCount: number;
}

export interface UserListOptions {
  username: string;
  rows: UserRow[];
  search: string;
  csrf: string;
  page: PageInfo;
  error?: string;
  notice?: string;
}

export function renderUserListPage(options: UserListOptions): string {
  const { rows } = options;

  const body = rows.length === 0
    ? `    <p class="empty">Aucun utilisateur${options.search ? ' ne correspond à cette recherche' : ''}.</p>`
    : `    <table>
      <thead>
        <tr>
          <th>Email</th>
          <th>Statut</th>
          <th>Clients</th>
          <th>Créé le</th>
          <th>Dernière connexion</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
${rows.map((row) => renderUserRow(row, options.csrf)).join('\n')}
      </tbody>
    </table>
${renderPagination(options.page)}`;

  return consolePage('Helvetik — Utilisateurs', { username: options.username, active: 'users' },
    `    <h1>Utilisateurs</h1>
${alertBlock(options.error, options.notice)}
    <div class="toolbar">
      <form method="get" action="/admin/users">
        <input name="q" type="search" value="${escapeHtml(options.search)}" placeholder="Rechercher par email…" aria-label="Rechercher un utilisateur">
        <button type="submit">Rechercher</button>
      </form>
      <a class="btn-primary" href="/admin/users/new">Nouvel utilisateur</a>
    </div>
${body}`);
}

function renderUserRow(row: UserRow, csrf: string): string {
  const { user } = row;
  const uid = escapeHtml(user.uid);
  const action = user.blocked ? 'unblock' : 'block';
  const actionLabel = user.blocked ? 'Débloquer' : 'Bloquer';
  const confirmMessage = user.blocked
    ? `Débloquer ${user.email} ?`
    : `Bloquer ${user.email} ? L'accès lui sera refusé.`;

  return `        <tr>
          <td>${escapeHtml(user.email)}</td>
          <td>${statusBadge(user.blocked)}</td>
          <td><a href="/admin/clients?userUid=${uid}">${row.clientCount}</a></td>
          <td>${formatDate(user.creationDate)}</td>
          <td>${formatDate(user.lastLoginDate)}</td>
          <td class="actions">
            <a href="/admin/users/${uid}/edit">Modifier</a>
            <form method="post" action="/admin/users/${uid}/${action}" style="display:inline"
                  data-confirm="${escapeHtml(confirmMessage)}">
              ${csrfField(csrf)}
              <button type="submit"${user.blocked ? '' : ' class="danger"'}>${actionLabel}</button>
            </form>
          </td>
        </tr>`;
}

export interface UserFormValues {
  email?: string;
  blocked?: boolean;
}

export interface UserFormOptions {
  username: string;
  csrf: string;
  /** Absent en création. */
  uid?: string;
  values: UserFormValues;
  minPasswordLength: number;
  error?: string;
}

export function renderUserFormPage(options: UserFormOptions): string {
  const isEdit = Boolean(options.uid);
  const title = isEdit ? 'Modifier l\'utilisateur' : 'Nouvel utilisateur';
  const action = isEdit ? `/admin/users/${escapeHtml(options.uid!)}/edit` : '/admin/users/new';
  const values = options.values;

  const passwordLegend = isEdit
    ? 'Mot de passe (laisser vide pour ne pas le changer)'
    : 'Mot de passe';

  return consolePage(`Helvetik — ${title}`, { username: options.username, active: 'users' },
    `    <h1>${escapeHtml(title)}</h1>
${alertBlock(options.error)}
    <form class="panel" method="post" action="${action}">
      ${csrfField(options.csrf)}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" value="${escapeHtml(values.email || '')}" autocomplete="off" autofocus required>

      <fieldset>
        <legend>${escapeHtml(passwordLegend)}</legend>
        <label for="password">Mot de passe</label>
        <input id="password" name="password" type="password" autocomplete="new-password"
               minlength="${options.minPasswordLength}"${isEdit ? '' : ' required'}>

        <label for="confirmPassword">Confirmation</label>
        <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password"
               minlength="${options.minPasswordLength}"${isEdit ? '' : ' required'}>
      </fieldset>

      <label for="blocked">Statut</label>
      <select id="blocked" name="blocked">
        <option value="false"${values.blocked ? '' : ' selected'}>Actif</option>
        <option value="true"${values.blocked ? ' selected' : ''}>Bloqué</option>
      </select>

      <div class="form-actions">
        <button type="submit">${isEdit ? 'Enregistrer' : 'Créer'}</button>
        <a href="/admin/users">Annuler</a>
      </div>
    </form>`);
}
