/**
 * Page des réglages de la console d'administration.
 */

import { alertBlock, consolePage, csrfField, escapeHtml, formatDate } from './layout';

export interface SettingView {
  key: string;
  value: boolean;
  overridden: boolean;
  environmentDefault: boolean;
  updatedAt?: Date;
  updatedBy?: string;
}

export interface SettingsPageOptions {
  username: string;
  csrf: string;
  emailConfirmation: SettingView;
  error?: string;
  notice?: string;
}

function origin(setting: SettingView): string {
  if (!setting.overridden) {
    return `<span class="muted">Valeur de la configuration du serveur (${setting.environmentDefault ? 'activée' : 'désactivée'}). ` +
      'Aucun choix enregistré depuis cette page.</span>';
  }
  return `<span class="muted">Fixé depuis cette console` +
    `${setting.updatedAt ? ` le ${formatDate(setting.updatedAt)}` : ''}` +
    `${setting.updatedBy ? ` par ${escapeHtml(setting.updatedBy)}` : ''}. ` +
    `La configuration du serveur indiquait « ${setting.environmentDefault ? 'activée' : 'désactivée'} ».</span>`;
}

export function renderSettingsPage(options: SettingsPageOptions): string {
  const s = options.emailConfirmation;

  return consolePage('Helvetik — Réglages', { username: options.username, active: 'settings' },
    `    <h1>Réglages</h1>
${alertBlock(options.error, options.notice)}

    <div class="panel" style="max-width:none">
      <h2 style="margin:0 0 .5rem;font-size:1.1rem">
        Confirmation d'adresse email
        <span class="badge ${s.value ? 'ok' : 'blocked'}">${s.value ? 'Exigée' : 'Désactivée'}</span>
      </h2>

      <p class="muted">
        Quand elle est exigée, un nouvel inscrit reçoit un email et ne peut se connecter
        qu'après avoir ouvert le lien. Désactivée, son compte est actif immédiatement et
        aucun email n'est envoyé.
      </p>
      <p class="muted">
        La désactiver augmente le nombre d'inscriptions abouties — aucune étape
        supplémentaire, aucun message perdu dans les indésirables — mais plus rien ne
        garantit que l'adresse saisie existe : les rappels d'échéance partiront dans le
        vide pour les adresses fautives.
      </p>
      <p>${origin(s)}</p>

      <form method="post" action="/admin/settings/email-confirmation">
        ${csrfField(options.csrf)}
        <label for="value">Confirmation d'email</label>
        <select id="value" name="value">
          <option value="true"${s.value ? ' selected' : ''}>Exigée — parcours complet</option>
          <option value="false"${s.value ? '' : ' selected'}>Désactivée — compte actif immédiatement</option>
        </select>
        <div class="form-actions">
          <button type="submit">Enregistrer</button>
        </div>
      </form>

      ${s.overridden ? `<form method="post" action="/admin/settings/email-confirmation/reset"
            data-confirm="Revenir à la valeur définie dans la configuration du serveur ?">
        ${csrfField(options.csrf)}
        <div class="form-actions">
          <button type="submit" class="danger">Revenir à la configuration du serveur</button>
        </div>
      </form>` : ''}

      <p class="muted">Le changement prend effet immédiatement, sans redémarrage. Les comptes
      créés pendant une période sans confirmation restent utilisables si vous la réactivez.</p>
    </div>`);
}
