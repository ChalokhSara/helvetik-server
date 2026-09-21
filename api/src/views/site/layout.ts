/**
 * Mise en page du site destiné aux assurés.
 *
 * Rendu côté serveur, sans framework ni étape de compilation : les pages
 * arrivent complètes, fonctionnent sans JavaScript et restent lisibles sur un
 * téléphone comme sur un écran large. C'est ce qui remplace l'application
 * mobile, avec les mêmes données et les mêmes règles.
 */

/**
 * Logo Helvetik, avec le mot-symbole en blanc plutôt qu'en bleu marine
 * lorsque la page est affichée en thème sombre — sans quoi il devient
 * illisible sur le fond sombre.
 */
export function logoPicture(className: string): string {
  return `<picture>
        <source srcset="/logo-dark.png" media="(prefers-color-scheme: dark)">
        <img class="${className}" src="/logo.png" alt="Helvetik">
      </picture>`;
}

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
  .brand-logo { height: 2.5rem; display: block; }
  .topbar .who {
    display: flex; flex-direction: column; align-items: flex-end; gap: .2rem;
    font-size: .85rem; color: var(--muted); line-height: 1.3;
  }
  .topbar .who a { font-size: .82rem; }

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

  /* --- navigation mobile : tiroir ouvert depuis un bouton en bas d'écran ---
     Rien en JavaScript : une case à cocher masquée, activée par les
     étiquettes (bouton et fond assombri), pilote l'affichage en CSS. */
  .nav-toggle { position: absolute; opacity: 0; pointer-events: none; }
  .nav-burger, .nav-drawer, .nav-backdrop { display: none; }

  @media (max-width: 680px) {
    nav.tabs { display: none; }

    body:has(.nav-burger) main { padding-bottom: 6rem; }

    .nav-burger {
      display: flex; align-items: center; justify-content: center;
      position: fixed; z-index: 30;
      left: 50%; bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
      transform: translateX(-50%);
      width: 56px; height: 56px; border-radius: 50%;
      background: var(--brand); box-shadow: 0 6px 18px rgba(0, 0, 0, .25);
      cursor: pointer;
    }
    .nav-burger .bar {
      display: block; width: 22px; height: 2px; background: #fff; border-radius: 2px;
      position: relative;
    }
    .nav-burger .bar::before, .nav-burger .bar::after {
      content: ''; position: absolute; left: 0; width: 22px; height: 2px;
      background: #fff; border-radius: 2px; transition: transform .2s;
    }
    .nav-burger .bar::before { top: -7px; }
    .nav-burger .bar::after { top: 7px; }

    .nav-backdrop {
      display: block; position: fixed; inset: 0; z-index: 28;
      background: rgba(15, 17, 21, .4);
      opacity: 0; pointer-events: none; transition: opacity .2s;
    }
    .nav-drawer {
      display: flex; flex-direction: column;
      position: fixed; z-index: 29; left: 0; right: 0; bottom: 0;
      background: var(--surface); border-top-left-radius: 18px; border-top-right-radius: 18px;
      box-shadow: 0 -8px 24px rgba(0, 0, 0, .2);
      padding: .5rem 0 calc(1rem + env(safe-area-inset-bottom, 0px));
      transform: translateY(100%); transition: transform .25s ease-out;
      max-height: 70vh; overflow-y: auto;
    }
    .nav-drawer a {
      padding: .95rem 1.25rem;
      color: var(--ink); text-decoration: none; font-size: 1rem;
      border-bottom: 1px solid var(--line);
    }
    .nav-drawer a.active { color: var(--brand); font-weight: 600; }
    .nav-drawer a:last-child { border-bottom: 0; }

    .nav-toggle:checked ~ .nav-backdrop { opacity: 1; pointer-events: auto; }
    .nav-toggle:checked ~ .nav-drawer { transform: translateY(0); }
    .nav-toggle:checked ~ .nav-burger .bar { background: transparent; }
    .nav-toggle:checked ~ .nav-burger .bar::before { transform: translateY(7px) rotate(45deg); }
    .nav-toggle:checked ~ .nav-burger .bar::after { transform: translateY(-7px) rotate(-45deg); }
  }

  main { max-width: 960px; margin: 0 auto; padding: 1.25rem 1rem 4rem; }

  /* --- accueil / écran de lancement --- */
  main.splash {
    max-width: none;
    min-height: 100dvh;
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
    padding: max(3.5rem, 10dvh) 1.25rem 3rem;
    padding-top: max(calc(3.5rem + env(safe-area-inset-top, 0px)), 10dvh);
    text-align: center;
    background:
      linear-gradient(180deg, rgba(255,255,255,.55) 0%, rgba(245,246,248,.92) 60%, var(--bg) 100%),
      url('/chalet-bg.jpg') center/cover no-repeat;
  }
  @media (prefers-color-scheme: dark) {
    main.splash {
      background:
        linear-gradient(180deg, rgba(15,17,21,.35) 0%, rgba(15,17,21,.85) 60%, var(--bg) 100%),
        url('/chalet-bg.jpg') center/cover no-repeat;
    }
  }
  .splash-card {
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid var(--line);
    border-radius: 20px;
    box-shadow: 0 20px 45px -18px rgba(15, 17, 21, .35);
    padding: 2rem 1.75rem 2rem;
    width: 100%; max-width: 360px;
    display: flex; flex-direction: column; align-items: center;
  }
  .splash-logo { width: min(230px, 60vw); height: auto; margin-bottom: 1.5rem; }
  .splash-actions { display: flex; flex-direction: column; align-items: center; gap: .9rem; width: 100%; }
  .splash-actions .btn { width: 100%; }
  .splash-actions .link { color: var(--muted); text-decoration: none; font-size: .88rem; }
  .splash-actions .link:hover { text-decoration: underline; }
  .splash-actions .btn.splash-secondary { margin-top: 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  .back-link {
    display: inline-flex; align-items: center; gap: .35rem;
    color: var(--muted); text-decoration: none; font-size: .9rem;
    margin-bottom: .75rem;
  }
  .back-link:hover { color: var(--brand); }
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
  /* Conseil rattaché à un champ : collé sous son input, sans l'espacement d'un paragraphe libre. */
  .field-hint { margin: -.7rem 0 1rem; color: var(--muted); font-size: .82rem; }

  /* Page « décor » : même photo et même carte vitrée que l'accueil, pour les
     pages qui prolongent son parcours (ex. inscription). */
  body:has(main.scenic) {
    background: url('/chalet-bg.jpg') center/cover no-repeat fixed;
  }
  .card-glass {
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
  }

  /* --- parcours de mise en route (après inscription) --- */
  @keyframes onboarding-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  main.onboarding-enter { animation: onboarding-in .35s ease-out; }
  .onboarding-progress { display: flex; gap: .4rem; margin-bottom: .5rem; }
  .onboarding-progress span { flex: 1; height: 4px; border-radius: 2px; background: var(--line); }
  .onboarding-progress span.done, .onboarding-progress span.current { background: var(--brand); }
  .onboarding-step {
    color: var(--muted); font-size: .78rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: .04em; margin: 0 0 1rem;
  }
  .onboarding-skip { margin: 0; }
  .onboarding-skip .btn { width: auto; }

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
  /* --- signature manuscrite --- */
  .sigpad {
    position: relative;
    border: 2px dashed var(--line); border-radius: 10px;
    background: #fff;
    margin-bottom: .75rem;
    /* touch-action: le navigateur ne doit pas défiler pendant qu'on signe. */
    touch-action: none;
  }
  .sigpad canvas { display: block; width: 100%; height: auto; border-radius: 8px; cursor: crosshair; }
  .sig-hint {
    position: absolute; inset: 0; margin: 0;
    display: flex; align-items: center; justify-content: center;
    color: #9ca3af; font-size: 1.1rem; pointer-events: none;
  }
  .sig-hint[hidden] { display: none; }
  /* Le trait est noir : le cadre reste blanc même en thème sombre. */
  .sig-preview {
    max-width: 320px; width: 100%; background: #fff;
    border: 1px solid var(--line); border-radius: 8px; padding: .5rem;
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
  /* Envoi en cours : un anneau tourne devant le libellé, dans la couleur du texte du bouton. */
  @keyframes spin { to { transform: rotate(360deg); } }
  button.is-busy, button.is-busy:disabled { cursor: progress; opacity: .85; }
  button.is-busy::before {
    content: ''; flex: none;
    width: 1em; height: 1em; margin-right: .55em;
    border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  /* Bandeau affiché pendant un traitement long (analyse d'un document). */
  .busy-status {
    display: flex; align-items: center; gap: .85rem;
    margin-top: 1rem; padding: .9rem 1rem; border-radius: 8px;
    background: var(--info-bg); color: var(--info-ink); font-size: .92rem;
  }
  .busy-status::before {
    content: ''; flex: none;
    width: 1.6em; height: 1.6em;
    border: 3px solid currentColor; border-right-color: transparent; border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  .busy-status[hidden] { display: none; }
  @media (prefers-reduced-motion: reduce) {
    button.is-busy::before { animation-duration: 1.6s; }
    .busy-status::before { animation-duration: 1.8s; }
  }
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

  .stats-caption {
    color: var(--muted); font-size: .78rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: .04em; margin: 0 0 .5rem;
  }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; }
  .stat { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem; }
  .stat .value { display: block; font-size: 1.6rem; font-weight: 700; line-height: 1.2; }
  .stat .label { display: block; font-size: .85rem; color: var(--muted); margin-top: .15rem; }
  .stat.accent { background: var(--brand); border-color: var(--brand); color: #fff; }
  .stat.accent .label { color: rgba(255,255,255,.85); }
  /* État des faces d'une pièce d'identité, l'une sous l'autre. */
  .face-status {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem;
    padding: .65rem .8rem; margin-bottom: .5rem;
    border-radius: 8px; background: var(--warn-bg); color: var(--warn-ink); font-size: .9rem;
    overflow-wrap: anywhere;
  }
  .face-status.ok { background: var(--ok-bg); color: var(--ok-ink); }
  .face-actions { display: flex; gap: .4rem; }
  .face-actions form { margin: 0; }
  .face-actions .btn, .face-actions button { padding: .4rem .75rem; font-size: .85rem; }
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
  /* Bouton de choix : discret dans la liste, mais toujours atteignable au
     pouce — 44 px de haut, la cible minimale sur téléphone. */
  .offer .pick {
    display: inline-flex; align-items: center; min-height: 44px;
    padding: .4rem .9rem; margin-top: .5rem;
    border: 1px solid var(--brand); border-radius: 8px;
    color: var(--brand); background: transparent;
    font-size: .9rem; font-weight: 600; text-decoration: none;
  }
  .offer .pick:hover { background: var(--brand); color: #fff; }

  /* Raccourci vers la meilleure offre, posé au-dessus de la liste : c'est le
     geste que l'on veut rendre le plus court. */
  .quick-pick {
    display: flex; flex-wrap: wrap; align-items: center; gap: .75rem 1rem;
    padding: 1rem; margin-bottom: 1rem;
    background: var(--ok-bg); border-radius: 10px;
  }
  .quick-pick .sum { flex: 1 1 14rem; }
  .quick-pick .sum strong { font-size: 1.05rem; }
  .quick-pick .btn { flex: 0 0 auto; }
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
    .face-actions { width: 100%; }
    .face-actions > * { flex: 1; }
  }
`;

export interface SiteContext {
  /** Nom affiché dans la barre du haut ; absent = visiteur non connecté. */
  email?: string;
  active?: 'accueil' | 'assures' | 'assurances' | 'optimisation' | 'compte';
  /** Photo de fond et carte vitrée, comme l'accueil — pour les pages qui prolongent son parcours. */
  scenic?: boolean;
  /** Légère animation d'entrée, pour les étapes du parcours de mise en route. */
  onboarding?: boolean;
}

function tabs(active?: string): string {
  if (!active) {
    return '';
  }
  const tab = (href: string, label: string, key: string) =>
    `<a href="${href}"${active === key ? ' class="active"' : ''}>${label}</a>`;
  const links = [
    tab('/espace', 'Accueil', 'accueil'),
    tab('/espace/assures', 'Mes assurés', 'assures'),
    tab('/espace/assurances', 'Mes assurances', 'assurances'),
    tab('/espace/optimisation', 'Optimiser ma LAMal', 'optimisation')
  ].join('\n    ');

  // Barre d'onglets classique en haut, tiroir accessible depuis un bouton en
  // bas d'écran sur mobile (voir le commentaire CSS de .nav-toggle) : les
  // deux portent les mêmes liens, un seul est visible selon la largeur.
  return `  <nav class="tabs" aria-label="Navigation">
    ${links}
  </nav>
  <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-hidden="true">
  <label for="nav-toggle" class="nav-backdrop"></label>
  <nav class="nav-drawer" aria-label="Navigation">
    ${links}
  </nav>
  <label for="nav-toggle" class="nav-burger" aria-label="Ouvrir le menu">
    <span class="bar"></span>
  </label>`;
}

export function sitePage(title: string, ctx: SiteContext, body: string): string {
  const account = ctx.email
    ? `<span class="who"><span>${escapeHtml(ctx.email)}</span><a href="/deconnexion">Se déconnecter</a></span>`
    : '<span class="who"><a class="btn" href="/connexion">Se connecter</a></span>';

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
    <a class="brand" href="${ctx.email ? '/espace' : '/'}">${logoPicture('brand-logo')}</a>
    ${account}
  </header>
${tabs(ctx.active)}
  <main class="${[ctx.scenic && 'scenic', ctx.onboarding && 'onboarding-enter'].filter(Boolean).join(' ')}">
${body}
  </main>
${PAGE_SCRIPT}
</body>
</html>`;
}

/**
 * Comportements communs à toutes les pages.
 *
 * - Confirmation avant les actions destructrices, sans script en ligne dans
 *   les attributs : les données affichées restent du texte échappé.
 * - Bouton « occupé » pendant l'envoi d'un formulaire : certaines analyses
 *   (reconnaissance de texte, lecture d'une police) prennent plusieurs
 *   secondes, pendant lesquelles rien ne dit sinon que la demande est partie.
 *   Le bouton n'est désactivé qu'au tour suivant : désactivé tout de suite,
 *   il sortirait des données envoyées, avec son éventuelle valeur.
 *   Les formulaires qui annulent l'envoi pour le relancer eux-mêmes (photo
 *   réduite, signature convertie) appellent `helvetikBusy` directement.
 */
const PAGE_SCRIPT = `  <script>
    (function () {
      function busy(form, submitter) {
        var button = submitter || form.querySelector('button[type=submit], button:not([type])');
        if (!button || button.getAttribute('aria-busy')) { return; }
        button.setAttribute('aria-busy', 'true');
        setTimeout(function () { button.disabled = true; }, 0);

        // Traitement long annoncé par le formulaire lui-même (data-busy-message) :
        // le spinner est alors dans le bandeau, pas dans le bouton.
        var message = form.getAttribute('data-busy-message');
        var status = form.querySelector('.busy-status');
        if (message && status) {
          status.querySelector('.busy-text').textContent = message;
          status.hidden = false;
        } else {
          button.classList.add('is-busy');
        }
      }
      window.helvetikBusy = busy;

      document.addEventListener('submit', function (event) {
        var message = event.target.getAttribute('data-confirm');
        if (message && !window.confirm(message)) { event.preventDefault(); return; }
        if (!event.defaultPrevented) { busy(event.target, event.submitter); }
      });

      // Retour arrière depuis la page suivante : le navigateur peut restituer
      // la page telle qu'elle était, bouton bloqué compris.
      window.addEventListener('pageshow', function () {
        document.querySelectorAll('button[aria-busy]').forEach(function (button) {
          button.classList.remove('is-busy');
          button.removeAttribute('aria-busy');
          button.disabled = false;
        });
        document.querySelectorAll('.busy-status').forEach(function (status) { status.hidden = true; });
      });
    })();
  </script>`;

/** Écran plein cadre sans topbar ni onglets, pour l'accueil style application mobile. */
export function siteSplashPage(title: string, body: string): string {
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
  <main class="splash">
${body}
  </main>
${PAGE_SCRIPT}
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

/** Barre de progression du parcours de mise en route, 3 étapes fixes. */
export function onboardingProgress(step: 1 | 2 | 3): string {
  const dot = (n: number) =>
    `<span class="${n < step ? 'done' : n === step ? 'current' : ''}"></span>`;
  return `    <div class="onboarding-progress">${dot(1)}${dot(2)}${dot(3)}</div>
    <p class="onboarding-step">Étape ${step} sur 3</p>`;
}

/** Bouton « Ignorer cette étape » : poste vers une route dédiée, sans quitter le formulaire principal. */
export function skipStepButton(action: string, csrf: string, label = 'Ignorer cette étape'): string {
  return `<form method="post" action="${action}" class="onboarding-skip">
      ${csrfField(csrf)}
      <button type="submit" class="btn btn-ghost">${escapeHtml(label)}</button>
    </form>`;
}

/** Flèche de retour vers la page qui a mené ici, posée au-dessus du titre. */
export function backLink(href: string, label: string): string {
  return `    <a class="back-link" href="${href}">← ${escapeHtml(label)}</a>`;
}
