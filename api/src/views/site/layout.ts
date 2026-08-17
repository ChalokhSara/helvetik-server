/**
 * Mise en page du site destiné aux assurés.
 *
 * Rendu côté serveur, sans framework ni étape de compilation : les pages
 * arrivent complètes, fonctionnent sans JavaScript et restent lisibles sur un
 * téléphone comme sur un écran large. C'est ce qui remplace l'application
 * mobile, avec les mêmes données et les mêmes règles.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function money(amount: number, currency = 'CHF'): string {
  return `${amount.toFixed(2)} ${currency}`;
}

export function formatDate(date?: Date | null): string {
  if (!date) {
    return '—';
  }
  return new Date(date).toLocaleDateString('fr-CH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

export function toDateInputValue(date?: Date | null): string {
  return date ? new Date(date).toISOString().slice(0, 10) : '';
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8;
    --surface: #ffffff;
    --ink: #16181d;
    --muted: #6b7280;
    --line: #e4e6eb;
    --brand: #d8232a;
    --brand-dark: #ad1b21;
    --ok-bg: #dcfce7; --ok-ink: #14532d;
    --warn-bg: #fef3c7; --warn-ink: #78350f;
    --err-bg: #fee2e2; --err-ink: #991b1b;
    --info-bg: #e0efff; --info-ink: #1e3a8a;
    --radius: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --surface: #191c22; --ink: #e8eaed; --muted: #9aa1ac;
      --line: #2a2f38;
      --ok-bg: #10301c; --ok-ink: #86efac;
      --warn-bg: #3a2c0c; --warn-ink: #fcd34d;
      --err-bg: #2c1315; --err-ink: #fca5a5;
      --info-bg: #14213d; --info-ink: #93c5fd;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  a { color: var(--brand); }

  /* --- ossature --- */
  .topbar {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: .85rem 1rem;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }
  .brand {
    display: inline-flex; align-items: baseline; gap: .5rem;
    font-weight: 700; font-size: 1.15rem; color: var(--ink); text-decoration: none;
  }
  .brand span { color: var(--brand); }
  .topbar .who { font-size: .85rem; color: var(--muted); }
  .topbar .who a { margin-left: .6rem; }

  nav.tabs {
    display: flex; gap: .25rem; overflow-x: auto;
    padding: 0 .5rem;
    background: var(--surface); border-bottom: 1px solid var(--line);
    scrollbar-width: none;
  }
  nav.tabs::-webkit-scrollbar { display: none; }
  nav.tabs a {
    flex: 0 0 auto;
    padding: .8rem .75rem;
    color: var(--muted); text-decoration: none; font-size: .92rem; white-space: nowrap;
    border-bottom: 2px solid transparent;
  }
  nav.tabs a.active { color: var(--brand); border-bottom-color: var(--brand); font-weight: 600; }

  main { max-width: 960px; margin: 0 auto; padding: 1.25rem 1rem 4rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  h2 { font-size: 1.1rem; margin: 0 0 .75rem; }
  p.lead { color: var(--muted); margin-top: -.5rem; }

  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 1.15rem;
    margin-bottom: 1rem;
  }
  .card h2 { margin-bottom: .5rem; }
  .muted { color: var(--muted); font-size: .88rem; }

  /* --- formulaires --- */
  label { display: block; margin: 0 0 .35rem; font-size: .85rem; font-weight: 600; }
  input, select, textarea {
    width: 100%; padding: .7rem .8rem; margin-bottom: 1rem;
    background: var(--surface); color: inherit;
    border: 1px solid var(--line); border-radius: 8px;
    font: inherit;
  }
  input:focus, select:focus, textarea:focus {
    outline: 2px solid var(--brand); outline-offset: 1px; border-color: transparent;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 0 1rem; }
  fieldset { border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1rem .25rem; margin: 0 0 1.25rem; }
  legend { padding: 0 .4rem; font-size: .78rem; font-weight: 700; text-transform: uppercase; color: var(--muted); }
  /* Valeur calculée par le serveur, affichée comme un champ mais non saisissable. */
  .readout {
    display: block; width: 100%; padding: .7rem .8rem; margin-bottom: 1rem;
    background: var(--bg); border: 1px dashed var(--line); border-radius: 8px;
    font-weight: 700;
  }
  /* --- propositions d'adresses --- */
  /* La liste flotte au-dessus du formulaire : elle ne doit pas déplacer les
     champs suivants à chaque frappe. */
  .suggest { position: relative; }
  .suggest-list {
    position: absolute; z-index: 20; left: 0; right: 0; top: 100%;
    margin: -.85rem 0 0; padding: .25rem; list-style: none;
    max-height: 15rem; overflow-y: auto;
    background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, .14);
  }
  .suggest-list[hidden] { display: none; }
  .suggest-list li { padding: .55rem .6rem; border-radius: 6px; cursor: pointer; font-size: .92rem; }
  .suggest-list li:hover, .suggest-list li.on { background: var(--bg); }

  .check { display: flex; align-items: flex-start; gap: .6rem; margin-bottom: 1rem; }
  .check input { width: auto; margin: .25rem 0 0; }
  .check label { margin: 0; font-weight: 400; font-size: .92rem; }

  button, .btn {
    display: inline-flex; align-items: center; justify-content: center;
    padding: .75rem 1.15rem;
    border: 0; border-radius: 8px;
    background: var(--brand); color: #fff;
    font: inherit; font-weight: 600; text-decoration: none;
    cursor: pointer;
  }
  button:hover, .btn:hover { background: var(--brand-dark); }
  .btn-ghost { background: transparent; color: var(--brand); border: 1px solid var(--line); }
  .btn-ghost:hover { background: var(--bg); }
  .btn-danger { background: transparent; color: var(--err-ink); border: 1px solid var(--line); }
  .btn-danger:hover { background: var(--err-bg); }
  .actions { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-top: .5rem; }
  .actions .link { color: var(--muted); text-decoration: none; font-size: .9rem; }

  /* --- messages --- */
  .msg { padding: .8rem .9rem; border-radius: 8px; margin-bottom: 1rem; font-size: .9rem; }
  .msg.err { background: var(--err-bg); color: var(--err-ink); }
  .msg.ok { background: var(--ok-bg); color: var(--ok-ink); }
  .msg.info { background: var(--info-bg); color: var(--info-ink); }
  .msg.warn { background: var(--warn-bg); color: var(--warn-ink); }
  .msg ul { margin: .4rem 0 0; padding-left: 1.1rem; }
  .msg[hidden] { display: none; }

  /* --- champs en faute --- */
  input.invalid, select.invalid, textarea.invalid {
    border-color: #dc2626;
    border-width: 2px;
    background: color-mix(in srgb, #dc2626 6%, var(--surface));
  }
  input.invalid:focus, select.invalid:focus, textarea.invalid:focus {
    outline-color: #dc2626;
  }
  .field-error {
    margin: -.8rem 0 .9rem;
    color: #b91c1c;
    font-size: .82rem;
    font-weight: 600;
  }
  @media (prefers-color-scheme: dark) {
    .field-error { color: #fca5a5; }
  }

  /* --- listes de données --- */
  .items { list-style: none; margin: 0; padding: 0; }
  .items li {
    display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; justify-content: space-between;
    padding: .9rem 0; border-bottom: 1px solid var(--line);
  }
  .items li:last-child { border-bottom: 0; }
  .items .title { font-weight: 600; }
  .items .meta { color: var(--muted); font-size: .85rem; }
  .items .right { text-align: right; margin-left: auto; }

  .badge {
    display: inline-block; padding: .12rem .5rem; border-radius: 999px;
    font-size: .74rem; font-weight: 700; letter-spacing: .01em;
  }
  .badge.ok { background: var(--ok-bg); color: var(--ok-ink); }
  .badge.off { background: var(--err-bg); color: var(--err-ink); }
  .badge.soon { background: var(--warn-bg); color: var(--warn-ink); }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; }
  .stat { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem; }
  .stat .value { display: block; font-size: 1.6rem; font-weight: 700; line-height: 1.2; }
  .stat .label { display: block; font-size: .85rem; color: var(--muted); margin-top: .15rem; }
  .stat.accent { background: var(--brand); border-color: var(--brand); color: #fff; }
  .stat.accent .label { color: rgba(255,255,255,.85); }
  /* Légende nommant la stratégie comparée, au-dessus du montant. */
  .stat .cap {
    display: block; margin-bottom: .3rem;
    font-size: .72rem; font-weight: 700; line-height: 1.25;
    text-transform: uppercase; letter-spacing: .03em;
    color: var(--muted);
  }
  .stat.accent .cap { color: rgba(255,255,255,.9); }
  /* Quatre encadrés : deux par ligne sur téléphone, quatre sur grand écran. */
  .stats-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stats-4 .stat { padding: .8rem; }
  .stats-4 .value { font-size: 1.35rem; }
  @media (min-width: 720px) { .stats-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); } }

  .empty { padding: 2rem 1rem; text-align: center; color: var(--muted); }

  /* --- mise en avant de l'économie atteignable --- */
  .card.opportunity {
    border-color: #15803d; border-width: 2px;
    background: linear-gradient(180deg, var(--ok-bg), var(--surface) 65%);
  }
  .opportunity .cap {
    display: block;
    font-size: .72rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    color: #15803d;
  }
  .opportunity .figure {
    margin: .1rem 0 .4rem;
    font-size: 2.1rem; font-weight: 700; line-height: 1.1; color: #15803d;
  }
  .opportunity .figure small { font-size: .95rem; font-weight: 400; color: var(--muted); }
  .card.cta { border-color: var(--brand); }
  @media (prefers-color-scheme: dark) {
    .card.opportunity { border-color: #4ade80; }
    .opportunity .cap, .opportunity .figure { color: #4ade80; }
  }

  /* --- liste des offres, pensée pour le téléphone --- */
  .offers { list-style: none; margin: 0; padding: 0; }
  .offer {
    padding: .85rem 0;
    border-bottom: 1px solid var(--line);
  }
  .offer:last-child { border-bottom: 0; }
  .offer.current { background: var(--ok-bg); border-radius: 8px; padding: .85rem .8rem; margin: .3rem 0; }
  .offer .who {
    font-size: 1rem; font-weight: 600; line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .offer .who .model { font-weight: 400; color: var(--muted); }
  .offer .line {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: .75rem; margin-top: .35rem;
  }
  .offer .delta { font-size: 1.15rem; font-weight: 700; white-space: nowrap; }
  .offer .delta.gain { color: #15803d; }
  .offer .delta.loss { color: #b91c1c; }
  .offer .delta.same { color: var(--muted); font-weight: 600; }
  .offer .price { font-size: 1.05rem; font-weight: 600; white-space: nowrap; }
  .offer .price small { font-weight: 400; color: var(--muted); }
  @media (prefers-color-scheme: dark) {
    .offer .delta.gain { color: #4ade80; }
    .offer .delta.loss { color: #f87171; }
  }

  /* Répartition individuelle : le nom passe avant la caisse. */
  .offer.plan .person { font-size: .95rem; font-weight: 700; }
  .offer.plan .who { font-size: .9rem; font-weight: 500; margin-top: .1rem; }

  /* --- bloc repliable portant le total combiné --- */
  .combo { border: 1px solid var(--line); border-radius: 10px; }
  .combo > summary {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: .75rem; padding: .8rem .9rem;
    cursor: pointer; list-style: none;
    font-weight: 600;
  }
  .combo > summary::-webkit-details-marker { display: none; }
  .combo > summary::after {
    content: '▾'; color: var(--muted); font-size: .8rem;
    transition: transform .15s;
  }
  .combo[open] > summary::after { transform: rotate(180deg); }
  .combo .combo-label small { font-weight: 400; color: var(--muted); }
  .combo .combo-total { font-size: 1.2rem; font-weight: 700; white-space: nowrap; margin-left: auto; }
  .combo .combo-total small { font-size: .8rem; font-weight: 400; color: var(--muted); }
  .combo .offers { padding: 0 .9rem .4rem; border-top: 1px solid var(--line); }

  /* --- onglets sans JavaScript : des radios pilotent l'affichage --- */
  .tabset > input[type=radio] { position: absolute; opacity: 0; pointer-events: none; }
  .tablist { display: flex; gap: .4rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .tablist label {
    flex: 1 1 8rem; min-width: 0;
    padding: .55rem .7rem;
    border: 1px solid var(--line); border-radius: 10px;
    cursor: pointer; text-align: center;
    font-weight: 600; font-size: .95rem; line-height: 1.25;
    color: var(--muted); background: transparent;
  }
  .tablist label small { display: block; font-size: .75rem; font-weight: 400; }
  .tablist label .badge {
    display: inline-block; margin-left: .35rem;
    padding: .05rem .35rem; border-radius: 999px;
    background: #15803d; color: #fff;
    font-size: .7rem; font-weight: 700; vertical-align: middle;
  }
  .panel { display: none; }
  #vue-groupe:checked ~ .tablist label[for=vue-groupe],
  #vue-individuel:checked ~ .tablist label[for=vue-individuel] {
    background: var(--brand); border-color: var(--brand); color: #fff;
  }
  #vue-groupe:checked ~ .tablist label[for=vue-groupe] small,
  #vue-individuel:checked ~ .tablist label[for=vue-individuel] small { color: rgba(255,255,255,.85); }
  #vue-individuel:checked ~ .tablist label[for=vue-individuel] .badge { background: #fff; color: #15803d; }
  #vue-groupe:checked ~ .panel-groupe,
  #vue-individuel:checked ~ .panel-individuel { display: block; }
  /* Le focus clavier doit rester visible : la radio elle-même est masquée. */
  #vue-groupe:focus-visible ~ .tablist label[for=vue-groupe],
  #vue-individuel:focus-visible ~ .tablist label[for=vue-individuel] {
    outline: 2px solid var(--brand); outline-offset: 2px;
  }

  /* --- prise de photo dans la page --- */
  .camera { margin: .5rem 0 1rem; }
  .camera .stage {
    position: relative;
    border-radius: 10px; overflow: hidden;
    background: #000;
    aspect-ratio: 4 / 3;
    display: none;
  }
  .camera .stage.on { display: block; }
  .camera video, .camera img.shot {
    display: block; width: 100%; height: 100%; object-fit: cover;
  }
  .camera img.shot { display: none; }
  .camera .stage.shot video { display: none; }
  .camera .stage.shot img.shot { display: block; }
  /* Repère de cadrage : la carte tient dans le rectangle. */
  .camera .frame {
    position: absolute; inset: 8% 6%;
    border: 2px dashed rgba(255,255,255,.75); border-radius: 8px;
    pointer-events: none;
  }
  .camera .stage.shot .frame { display: none; }
  .camera .row { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: .6rem; }
  .camera .row button { flex: 1 1 auto; }
  .camera[hidden] { display: none; }

  /* --- tableau qui devient liste sur petit écran --- */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .92rem; }
  th, td { padding: .65rem .6rem; text-align: left; border-bottom: 1px solid var(--line); }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tr.highlight td { background: var(--ok-bg); }

  @media (max-width: 560px) {
    main { padding: 1rem .75rem 3rem; }
    .topbar { padding: .75rem .75rem; }
    .items li { flex-direction: column; align-items: flex-start; }
    .items .right { text-align: left; margin-left: 0; }
    button, .btn { width: 100%; }
    .actions { flex-direction: column; align-items: stretch; }
  }
`;

export interface SiteContext {
  /** Nom affiché dans la barre du haut ; absent = visiteur non connecté. */
  email?: string;
  active?: 'accueil' | 'assures' | 'assurances' | 'optimisation' | 'compte';
}

function tabs(active?: string): string {
  if (!active) {
    return '';
  }
  const tab = (href: string, label: string, key: string) =>
    `<a href="${href}"${active === key ? ' class="active"' : ''}>${label}</a>`;

  return `  <nav class="tabs" aria-label="Navigation">
    ${tab('/espace', 'Accueil', 'accueil')}
    ${tab('/espace/assures', 'Mes assurés', 'assures')}
    ${tab('/espace/assurances', 'Mes assurances', 'assurances')}
    ${tab('/espace/optimisation', 'Optimiser ma LAMal', 'optimisation')}
  </nav>`;
}

export function sitePage(title: string, ctx: SiteContext, body: string): string {
  const account = ctx.email
    ? `<span class="who">${escapeHtml(ctx.email)}<a href="/deconnexion">Se déconnecter</a></span>`
    : '<span class="who"><a href="/connexion">Se connecter</a></span>';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="Helvetik — suivez vos assurances et comparez vos primes d'assurance maladie.">
  <title>${escapeHtml(title)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="${ctx.email ? '/espace' : '/'}">Helvetik<span>.</span></a>
    ${account}
  </header>
${tabs(ctx.active)}
  <main>
${body}
  </main>
  <script>
    // Confirmation avant les actions destructrices, sans script en ligne
    // dans les attributs : les données affichées restent du texte échappé.
    document.addEventListener('submit', function (event) {
      var message = event.target.getAttribute('data-confirm');
      if (message && !window.confirm(message)) { event.preventDefault(); }
    });
  </script>
</body>
</html>`;
}

/** Page centrée sur une carte étroite : connexion, inscription, messages. */
export function siteCardPage(title: string, body: string): string {
  return sitePage(title, {}, `    <div style="max-width:26rem;margin:2rem auto">
${body}
    </div>`);
}

export function messages(options: { error?: string; notice?: string; info?: string; warnings?: string[] }): string {
  const parts: string[] = [];
  if (options.error) {
    parts.push(`    <p class="msg err" role="alert">${escapeHtml(options.error)}</p>`);
  }
  if (options.notice) {
    parts.push(`    <p class="msg ok">${escapeHtml(options.notice)}</p>`);
  }
  if (options.info) {
    parts.push(`    <p class="msg info">${escapeHtml(options.info)}</p>`);
  }
  if (options.warnings?.length) {
    parts.push(`    <div class="msg warn"><strong>À vérifier</strong><ul>${
      options.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')
    }</ul></div>`);
  }
  return parts.join('\n');
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}
