/**
 * Pages d'authentification de la console d'administration.
 */

import { alertBlock, cardPage, consolePage, csrfField, escapeHtml } from './layout';

export function renderLoginPage(
  options: { error?: string; username?: string; csrf?: string } = {}
): string {
  const username = escapeHtml(options.username || '');

  return cardPage('Helvetik — Administration', `    <h1>Helvetik</h1>
    <p class="subtitle">Console d'administration</p>
${alertBlock(options.error)}
    <form method="post" action="/admin/login">
      ${csrfField(options.csrf || '')}
      <label for="username">Nom d'utilisateur</label>
      <input id="username" name="username" type="text" value="${username}" autocomplete="username" autofocus required>

      <label for="password">Mot de passe</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>

      <button type="submit">Se connecter</button>
    </form>`);
}

export function renderChangePasswordPage(
  options: { error?: string; forced?: boolean; minLength?: number; csrf?: string } = {}
): string {
  const notice = options.forced
    ? 'Le mot de passe par défaut doit être remplacé avant d\'accéder à la console.'
    : undefined;

  return cardPage('Helvetik — Mot de passe', `    <h1>Nouveau mot de passe</h1>
    <p class="subtitle">Compte administrateur</p>
${alertBlock(options.error, notice)}
    <form method="post" action="/admin/password">
      ${csrfField(options.csrf || '')}
      <label for="currentPassword">Mot de passe actuel</label>
      <input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" autofocus required>

      <label for="newPassword">Nouveau mot de passe</label>
      <input id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="${options.minLength || 8}" required>

      <label for="confirmPassword">Confirmer le nouveau mot de passe</label>
      <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="${options.minLength || 8}" required>

      <button type="submit">Enregistrer</button>
    </form>`);
}

export interface DashboardStats {
  users: number;
  blockedUsers: number;
  clients: number;
  blockedClients: number;
  insurances: number;
  activeInsurances: number;
}

export function renderDashboardPage(username: string, stats: DashboardStats): string {
  const card = (label: string, value: number, href: string, hint: string) =>
    `      <a class="stat" href="${href}">
        <span class="stat-value">${value}</span>
        <span class="stat-label">${escapeHtml(label)}</span>
        <span class="stat-hint">${escapeHtml(hint)}</span>
      </a>`;

  return consolePage('Helvetik — Administration', { username, active: 'dashboard' }, `    <h1>Tableau de bord</h1>
    <style>
      .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
      .stat {
        display: block;
        padding: 1.25rem;
        background: #fff;
        border-radius: 10px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
        text-decoration: none;
        color: inherit;
      }
      .stat:hover { box-shadow: 0 2px 10px rgba(0, 0, 0, .1); }
      .stat-value { display: block; font-size: 1.9rem; font-weight: 700; }
      .stat-label { display: block; margin-top: .2rem; font-size: .9rem; font-weight: 600; }
      .stat-hint { display: block; margin-top: .3rem; font-size: .8rem; color: #6b7280; }
      @media (prefers-color-scheme: dark) {
        .stat { background: #1c1f26; box-shadow: none; border: 1px solid #2a2f3a; }
        .stat-hint { color: #9ca3af; }
      }
    </style>
    <div class="stats">
${card('Utilisateurs', stats.users, '/admin/users', `${stats.blockedUsers} bloqué(s)`)}
${card('Clients', stats.clients, '/admin/clients', `${stats.blockedClients} bloqué(s)`)}
${card('Assurances', stats.insurances, '/admin/insurances', `${stats.activeInsurances} en vigueur`)}
    </div>`);
}
