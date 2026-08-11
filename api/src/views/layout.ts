/**
 * Briques communes aux pages de la console d'administration —
 * rendues côté serveur, sans dépendance de templating.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_STYLES = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #f4f5f7;
      color: #1a1a1a;
    }
    label { display: block; margin-bottom: .4rem; font-size: .85rem; font-weight: 600; }
    input, select {
      width: 100%;
      padding: .65rem .75rem;
      margin-bottom: 1.1rem;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: .95rem;
      background: #fff;
      color: inherit;
    }
    input:focus, select:focus { outline: 2px solid #dc2626; outline-offset: 1px; border-color: transparent; }
    button {
      padding: .7rem 1.1rem;
      border: 0;
      border-radius: 6px;
      background: #dc2626;
      color: #fff;
      font-size: .95rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #b91c1c; }
    .notice, .error {
      margin: 0 0 1.25rem;
      padding: .65rem .75rem;
      border-radius: 6px;
      font-size: .85rem;
    }
    .error { background: #fef2f2; color: #991b1b; }
    .notice { background: #eff6ff; color: #1e40af; }
    @media (prefers-color-scheme: dark) {
      body { background: #111317; color: #e5e7eb; }
      input, select { background: #111317; border-color: #374151; }
      .error { background: #2a1416; color: #fca5a5; }
      .notice { background: #14203a; color: #93c5fd; }
    }`;

const CARD_STYLES = `${BASE_STYLES}
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      width: 100%;
      max-width: 380px;
      padding: 2.5rem;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 24px rgba(0, 0, 0, .08);
    }
    .card button { width: 100%; }
    h1 { margin: 0 0 .25rem; font-size: 1.4rem; }
    .subtitle { margin: 0 0 1.75rem; color: #6b7280; font-size: .9rem; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1c1f26; box-shadow: none; }
      .subtitle { color: #9ca3af; }
    }`;

const CONSOLE_STYLES = `${BASE_STYLES}
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 1rem 2rem;
      background: #fff;
      border-bottom: 1px solid #e5e7eb;
    }
    header strong { font-size: 1.05rem; }
    header a { color: #dc2626; font-size: .9rem; text-decoration: none; }
    header a:hover { text-decoration: underline; }
    nav {
      display: flex;
      gap: .5rem;
      padding: 0 2rem;
      background: #fff;
      border-bottom: 1px solid #e5e7eb;
    }
    nav a {
      padding: .75rem .25rem;
      margin-right: 1rem;
      color: #4b5563;
      font-size: .9rem;
      text-decoration: none;
      border-bottom: 2px solid transparent;
    }
    nav a:hover { color: #1a1a1a; }
    nav a.active { color: #dc2626; border-bottom-color: #dc2626; font-weight: 600; }
    main { padding: 2rem; max-width: 1100px; }
    h1 { margin: 0 0 1.5rem; font-size: 1.3rem; }
    .toolbar {
      display: flex;
      align-items: center;
      gap: .75rem;
      margin-bottom: 1.25rem;
    }
    .toolbar form { display: flex; gap: .5rem; flex: 1; }
    .toolbar input { margin-bottom: 0; max-width: 320px; }
    .toolbar button { background: #4b5563; }
    .toolbar button:hover { background: #374151; }
    .btn-primary {
      display: inline-block;
      padding: .7rem 1.1rem;
      border-radius: 6px;
      background: #dc2626;
      color: #fff;
      font-size: .95rem;
      font-weight: 600;
      text-decoration: none;
      white-space: nowrap;
    }
    .btn-primary:hover { background: #b91c1c; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
      font-size: .9rem;
    }
    th, td { padding: .7rem .9rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { background: #f9fafb; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; color: #6b7280; }
    tr:last-child td { border-bottom: 0; }
    td.actions { white-space: nowrap; text-align: right; }
    td.actions a, td.actions button {
      padding: .3rem .6rem;
      margin-left: .3rem;
      border: 1px solid #d1d5db;
      border-radius: 5px;
      background: transparent;
      color: #374151;
      font-size: .82rem;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
    }
    td.actions a:hover, td.actions button:hover { background: #f3f4f6; }
    td.actions button.danger { color: #b91c1c; border-color: #fca5a5; }
    td.actions button.danger:hover { background: #fef2f2; }
    .badge {
      display: inline-block;
      padding: .15rem .5rem;
      border-radius: 999px;
      font-size: .75rem;
      font-weight: 600;
    }
    .badge.ok { background: #dcfce7; color: #166534; }
    .badge.blocked { background: #fee2e2; color: #991b1b; }
    .empty { padding: 2.5rem; text-align: center; color: #6b7280; background: #fff; border-radius: 8px; }
    .muted { color: #6b7280; font-size: .85rem; }
    .pagination { display: flex; gap: .75rem; align-items: center; margin-top: 1rem; font-size: .85rem; }
    .pagination a { color: #dc2626; text-decoration: none; }
    .panel {
      max-width: 620px;
      padding: 1.75rem;
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1rem; }
    .form-actions { display: flex; align-items: center; gap: 1rem; margin-top: .5rem; }
    .form-actions a { color: #6b7280; font-size: .9rem; text-decoration: none; }
    fieldset { margin: 0 0 1.25rem; padding: 1rem 1.1rem .25rem; border: 1px solid #e5e7eb; border-radius: 8px; }
    legend { padding: 0 .4rem; font-size: .8rem; font-weight: 600; text-transform: uppercase; color: #6b7280; }
    @media (prefers-color-scheme: dark) {
      header, nav, table, .panel { background: #1c1f26; }
      header, nav { border-color: #2a2f3a; }
      nav a { color: #9ca3af; }
      nav a:hover { color: #e5e7eb; }
      th { background: #232733; color: #9ca3af; }
      th, td { border-color: #2a2f3a; }
      td.actions a, td.actions button { color: #d1d5db; border-color: #374151; }
      td.actions a:hover, td.actions button:hover { background: #232733; }
      .badge.ok { background: #14321f; color: #86efac; }
      .badge.blocked { background: #2a1416; color: #fca5a5; }
      .empty, .muted, .pagination { color: #9ca3af; }
      .empty { background: #1c1f26; }
      fieldset { border-color: #2a2f3a; }
      table, .panel { box-shadow: none; }
    }
    @media (max-width: 640px) {
      .grid { grid-template-columns: 1fr; }
    }`;

export function alertBlock(error?: string, notice?: string): string {
  const parts: string[] = [];
  if (error) parts.push(`    <p class="error" role="alert">${escapeHtml(error)}</p>`);
  if (notice) parts.push(`    <p class="notice">${escapeHtml(notice)}</p>`);
  return parts.join('\n');
}

/**
 * Page centrée sur une carte : login, changement de mot de passe.
 */
export function cardPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${CARD_STYLES}
  </style>
</head>
<body>
  <main class="card">
${body}
  </main>
</body>
</html>`;
}

export interface ConsoleContext {
  username: string;
  /** Onglet de navigation à marquer actif. */
  active?: 'dashboard' | 'users' | 'clients' | 'insurances' | 'premiums' | 'settings';
}

/**
 * Page pleine largeur de la console : en-tête, navigation, contenu.
 */
export function consolePage(title: string, ctx: ConsoleContext, body: string): string {
  const safeUsername = escapeHtml(ctx.username);
  const tab = (href: string, label: string, key: string) =>
    `<a href="${href}"${ctx.active === key ? ' class="active"' : ''}>${label}</a>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${CONSOLE_STYLES}
  </style>
</head>
<body>
  <header>
    <strong>Helvetik — Administration</strong>
    <span>${safeUsername} · <a href="/admin/password">Mot de passe</a> · <a href="/admin/logout">Se déconnecter</a></span>
  </header>
  <nav>
    ${tab('/admin', 'Tableau de bord', 'dashboard')}
    ${tab('/admin/users', 'Utilisateurs', 'users')}
    ${tab('/admin/clients', 'Clients', 'clients')}
    ${tab('/admin/insurances', 'Assurances', 'insurances')}
    ${tab('/admin/premiums', 'Primes officielles', 'premiums')}
    ${tab('/admin/settings', 'Réglages', 'settings')}
  </nav>
  <main>
${body}
  </main>
  <script>
    // Confirmation générique : tout formulaire portant data-confirm.
    // Le message passe par un attribut plutôt que par du JS inline, pour que
    // les données affichées restent de simples chaînes échappées en HTML.
    document.addEventListener('submit', function (event) {
      var message = event.target.getAttribute('data-confirm');
      if (message && !window.confirm(message)) {
        event.preventDefault();
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Champ caché anti-CSRF, à inclure dans chaque formulaire de mutation.
 */
export function csrfField(token: string): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
  /** Base de l'URL, query string incluse hors paramètre `page`. */
  baseUrl: string;
}

export function renderPagination(info: PageInfo): string {
  const lastPage = Math.max(1, Math.ceil(info.total / info.pageSize));
  if (lastPage <= 1) {
    return '';
  }

  const link = (page: number, label: string) =>
    `<a href="${escapeHtml(info.baseUrl)}page=${page}">${label}</a>`;

  const parts: string[] = [];
  if (info.page > 1) parts.push(link(info.page - 1, '← Précédent'));
  parts.push(`<span class="muted">Page ${info.page} / ${lastPage} — ${info.total} résultat(s)</span>`);
  if (info.page < lastPage) parts.push(link(info.page + 1, 'Suivant →'));

  return `    <div class="pagination">${parts.join('')}</div>`;
}

export function statusBadge(blocked: boolean): string {
  return blocked
    ? '<span class="badge blocked">Bloqué</span>'
    : '<span class="badge ok">Actif</span>';
}

export function formatDate(date?: Date | null): string {
  if (!date) {
    return '—';
  }
  return new Date(date).toLocaleDateString('fr-CH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

/**
 * Date au format attendu par <input type="date">.
 */
export function toDateInputValue(date?: Date | null): string {
  if (!date) {
    return '';
  }
  return new Date(date).toISOString().slice(0, 10);
}
