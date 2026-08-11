/**
 * Pages du site destiné aux assurés.
 */

import { IClient } from '../../models/client.model';
import { IInsurance } from '../../models/insurance.model';
import { monthlyPremium, cancellationDeadline, lamalPeriodEnd } from '../../utils/insurance-payload';
import { OptimisationResult, modelLabel } from '../../services/lamal-optimisation.service';
import {
  csrfField,
  escapeHtml,
  formatDate,
  messages,
  money,
  sitePage,
  siteCardPage,
  toDateInputValue
} from './layout';
import {
  FREQUENCY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  HouseholdAddress,
  LamalCatalogue,
  Values,
  checkbox,
  errorSummary,
  importBlock,
  insuranceFields,
  insuredFields,
  radios,
  text,
  textarea,
  validationScript
} from './forms';
import { INTEREST_LABELS } from '../../models/feedback.model';

/** Liste des champs refusés par le serveur, transmise au script de validation. */
function invalidAttr(fields?: string[]): string {
  return fields?.length ? ` data-invalid="${escapeHtml(fields.join(' '))}"` : '';
}

// ---------------------------------------------------------------- accueil

export function renderLanding(): string {
  return sitePage('Helvetik — vos assurances, au clair', {}, `    <div class="card" style="text-align:center">
      <h1>Vos assurances, au clair</h1>
      <p class="lead">Rassemblez les contrats de toute votre famille, recevez un rappel avant
      chaque échéance de résiliation, et comparez votre prime d'assurance maladie aux
      tarifs officiels de l'OFSP.</p>
      <div class="actions" style="justify-content:center">
        <a class="btn" href="/inscription">Créer mon compte</a>
        <a class="btn btn-ghost" href="/connexion">J'ai déjà un compte</a>
      </div>
    </div>

    <div class="stats">
      <div class="card"><h2>Toute la famille</h2><p class="muted">Un compte, autant d'assurés que
      nécessaire : conjoint, enfants, chacun avec ses contrats.</p></div>
      <div class="card"><h2>Plus d'échéance ratée</h2><p class="muted">Un rappel par email 90, 30
      et 7 jours avant la date limite de résiliation.</p></div>
      <div class="card"><h2>Primes officielles</h2><p class="muted">La comparaison s'appuie sur les
      tarifs publiés par l'Office fédéral de la santé publique.</p></div>
    </div>`);
}

// ------------------------------------------------------------------- auth

export function renderLogin(options: { csrf: string; email?: string; error?: string; notice?: string }): string {
  return siteCardPage('Helvetik — Connexion', `      <h1>Se connecter</h1>
${messages(options)}
      <form method="post" action="/connexion" class="card">
        ${csrfField(options.csrf)}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" value="${escapeHtml(options.email || '')}" autocomplete="email" autofocus required>

        <label for="password">Mot de passe</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>

        <button type="submit">Se connecter</button>
      </form>
      <p class="muted" style="text-align:center">Pas encore de compte ?
      <a href="/inscription">Créer un compte</a></p>`);
}

export function renderRegister(options: {
  csrf: string;
  values: Values;
  error?: string;
  invalidFields?: string[];
}): string {
  return sitePage('Helvetik — Créer un compte', {}, `    <h1>Créer mon compte</h1>
    <p class="lead">Vos identifiants, puis vos informations personnelles : vous serez le premier
    assuré du foyer, et vous pourrez en ajouter d'autres ensuite.</p>
${messages(options)}
    <form method="post" action="/inscription" class="card" id="main-form"${invalidAttr(options.invalidFields)}>
      ${csrfField(options.csrf)}
${errorSummary()}
      <fieldset>
        <legend>Identifiants</legend>
        <div class="grid">
${text(options.values, 'accountEmail', 'Email de connexion', 'type="email" autocomplete="email"')}
${text(options.values, 'password', 'Mot de passe', 'type="password" autocomplete="new-password" minlength="8"')}
        </div>
        <p class="muted">Huit caractères au minimum. Un email de confirmation vous sera envoyé.</p>
      </fieldset>
${insuredFields(options.values, undefined, true)}
${validationScript()}
      <div class="actions">
        <button type="submit">Créer mon compte</button>
        <a class="link" href="/connexion">J'ai déjà un compte</a>
      </div>
    </form>`);
}

export function renderRegistered(email: string, emailSent: boolean): string {
  return siteCardPage('Helvetik — Compte créé', `      <div class="card">
        <h1>Compte créé</h1>
        <p class="msg ${emailSent ? 'ok' : 'warn'}">
          ${emailSent
            ? `Un email de confirmation vient d'être envoyé à ${escapeHtml(email)}.`
            : 'Le compte est créé, mais l\'email de confirmation n\'a pas pu être envoyé. Demandez-en un nouveau depuis la page de connexion.'}
        </p>
        <p class="muted">Ouvrez le lien reçu pour activer votre compte : la connexion n'est
        possible qu'une fois l'adresse confirmée.</p>
        <div class="actions"><a class="btn" href="/connexion">Aller à la connexion</a></div>
      </div>`);
}

export function renderEmailConfirmation(options: { success: boolean; message: string }): string {
  return siteCardPage('Helvetik — Confirmation d\'email', `      <div class="card">
        <h1>${options.success ? 'Adresse confirmée' : 'Lien invalide'}</h1>
        <p class="msg ${options.success ? 'ok' : 'err'}">${escapeHtml(options.message)}</p>
        <div class="actions">
          <a class="btn" href="/connexion">${options.success ? 'Se connecter' : 'Retour à la connexion'}</a>
        </div>
      </div>`);
}

// -------------------------------------------------------------- dashboard

export interface DashboardOptions {
  email: string;
  clients: IClient[];
  insurances: IInsurance[];
  monthlyTotal: number;
  nextDeadline?: { insurance: IInsurance; deadline: Date; daysLeft: number };
  savings?: { monthly: number; yearly: number } | null;
  notice?: string;
}

export function renderDashboard(o: DashboardOptions): string {
  const lamalCount = o.insurances.filter((i) => i.type === 'LAMAL').length;

  const deadline = o.nextDeadline
    ? `    <div class="card">
      <h2>Prochaine échéance de résiliation</h2>
      <p><strong>${escapeHtml(o.nextDeadline.insurance.provider)} — ${escapeHtml(o.nextDeadline.insurance.productName)}</strong><br>
      Résiliable jusqu'au <strong>${formatDate(o.nextDeadline.deadline)}</strong>,
      soit dans ${o.nextDeadline.daysLeft} jour(s).</p>
      <p class="muted">Un rappel par email vous parviendra automatiquement à 90, 30 et 7 jours.</p>
    </div>`
    : '';

  const savings = o.savings && o.savings.monthly > 0
    ? `    <div class="card">
      <h2>Vous pourriez économiser</h2>
      <p><span style="font-size:1.8rem;font-weight:700">${money(o.savings.monthly)}</span> par mois,
      soit ${money(o.savings.yearly)} par an, en changeant d'assurance de base.</p>
      <div class="actions"><a class="btn" href="/espace/optimisation">Voir les offres</a></div>
    </div>`
    : `    <div class="card">
      <h2>Optimiser votre LAMal</h2>
      <p class="muted">${lamalCount
        ? 'Comparez votre assurance de base aux tarifs officiels de l\'OFSP.'
        : 'Enregistrez votre assurance de base pour découvrir combien vous pourriez économiser.'}</p>
      <div class="actions"><a class="btn" href="${lamalCount ? '/espace/optimisation' : '/espace/assurances/nouvelle'}">
        ${lamalCount ? 'Comparer mes primes' : 'Ajouter ma LAMal'}</a></div>
    </div>`;

  return sitePage('Helvetik — Mon espace', { email: o.email, active: 'accueil' },
    `    <h1>Bonjour</h1>
${messages({ notice: o.notice })}
    <div class="stats" style="margin-bottom:1rem">
      <div class="stat"><span class="value">${o.clients.length}</span><span class="label">assuré(s)</span></div>
      <div class="stat"><span class="value">${o.insurances.length}</span><span class="label">contrat(s)</span></div>
      <div class="stat accent"><span class="value">${money(o.monthlyTotal)}</span><span class="label">par mois au total</span></div>
    </div>
${savings}
${deadline}
    <div class="card">
      <h2>Raccourcis</h2>
      <div class="actions">
        <a class="btn btn-ghost" href="/espace/assurances/nouvelle">Ajouter un contrat</a>
        <a class="btn btn-ghost" href="/espace/assures/nouveau">Ajouter un assuré</a>
      </div>
    </div>`);
}

// ---------------------------------------------------------------- assurés

export function renderClients(o: {
  email: string;
  clients: IClient[];
  insuranceCount: Map<string, number>;
  notice?: string;
}): string {
  const body = o.clients.length === 0
    ? '    <p class="empty">Aucun assuré pour l\'instant.</p>'
    : `    <ul class="items">
${o.clients.map((c) => `      <li>
        <span>
          <span class="title">${escapeHtml(c.firstname)} ${escapeHtml(c.name)}</span>
          ${c.blocked ? '<span class="badge off">Bloqué</span>' : ''}<br>
          <span class="meta">Né(e) le ${formatDate(c.birthdate)} · ${escapeHtml(c.plz)} ${escapeHtml(c.location)} ·
          ${o.insuranceCount.get(c.uid) || 0} contrat(s)</span>
        </span>
        <span class="right"><a class="btn btn-ghost" href="/espace/assures/${escapeHtml(c.uid)}/modifier">Modifier</a></span>
      </li>`).join('\n')}
    </ul>`;

  return sitePage('Helvetik — Mes assurés', { email: o.email, active: 'assures' },
    `    <h1>Mes assurés</h1>
    <p class="lead">Vous-même et les membres de votre famille couverts par vos contrats.</p>
${messages({ notice: o.notice })}
    <div class="card">
${body}
    </div>
    <div class="actions"><a class="btn" href="/espace/assures/nouveau">Ajouter un assuré</a></div>`);
}

export function renderClientForm(o: {
  email: string;
  csrf: string;
  values: Values;
  uid?: string;
  error?: string;
  info?: string;
  warnings?: string[];
  /** Adresse du foyer, proposée par défaut lors d un ajout. */
  householdAddress?: HouseholdAddress;
  /** Champs refusés par le serveur, à cercler de rouge au rechargement. */
  invalidFields?: string[];
  /** Vrai pour le premier assuré du compte, dont le téléphone est le contact. */
  requirePhone?: boolean;
}): string {
  const editing = Boolean(o.uid);
  const action = editing ? `/espace/assures/${escapeHtml(o.uid!)}/modifier` : '/espace/assures/nouveau';

  return sitePage(`Helvetik — ${editing ? 'Modifier un assuré' : 'Ajouter un assuré'}`,
    { email: o.email, active: 'assures' },
    `    <h1>${editing ? 'Modifier un assuré' : 'Ajouter un assuré'}</h1>
${messages(o)}
${editing ? '' : importBlock({
      action: '/espace/assures/importer',
      csrf: o.csrf,
      hint: 'Photographiez votre carte d\x27assuré : le numéro AVS, la date de naissance et la caisse en seront extraits.'
    })}
    <form method="post" action="${action}" class="card" id="main-form"${invalidAttr(o.invalidFields)}>
      ${csrfField(o.csrf)}
${errorSummary()}
${insuredFields(o.values, editing ? undefined : o.householdAddress, o.requirePhone === true)}
${validationScript()}
      <div class="actions">
        <button type="submit">${editing ? 'Enregistrer' : 'Ajouter'}</button>
        <a class="link" href="/espace/assures">Annuler</a>
      </div>
    </form>`);
}

// ------------------------------------------------------------- assurances

function statusBadge(status: string): string {
  const kind = status === 'ACTIVE' ? 'ok' : status === 'PENDING' ? 'soon' : 'off';
  return `<span class="badge ${kind}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
}

export function renderInsurances(o: {
  email: string;
  insurances: IInsurance[];
  clients: Map<string, IClient>;
  monthlyTotal: number;
  csrf: string;
  notice?: string;
  /** Économie atteignable, calculée à l'affichage de la page. */
  savings?: { monthly: number; yearly: number } | null;
  hasLamal?: boolean;
}): string {
  const body = o.insurances.length === 0
    ? '    <p class="empty">Aucun contrat enregistré.</p>'
    : `    <ul class="items">
${o.insurances.map((i) => {
    const client = o.clients.get(i.clientUid);
    const insured = client ? `${client.firstname} ${client.name}` : i.clientUid;
    const deadline = cancellationDeadline(i);
    return `      <li>
        <span>
          <span class="title">${escapeHtml(i.provider)} — ${escapeHtml(i.productName)}</span> ${statusBadge(i.status)}<br>
          <span class="meta">${escapeHtml(TYPE_LABELS[i.type] || i.type)} · ${escapeHtml(insured)} ·
          police ${escapeHtml(i.policyNumber)}${deadline ? ` · résiliable jusqu'au ${formatDate(deadline)}` : ''}</span>
        </span>
        <span class="right">
          <strong>${money(monthlyPremium(i.premiumAmount, i.premiumFrequency), i.currency)}</strong><span class="meta">/mois</span><br>
          <span class="meta">${escapeHtml(FREQUENCY_LABELS[i.premiumFrequency] || i.premiumFrequency)} : ${money(i.premiumAmount, i.currency)}</span><br>
          <span class="actions" style="justify-content:flex-end">
            <a class="btn btn-ghost" href="/espace/assurances/${escapeHtml(i.uid)}/modifier">Modifier</a>
            <form method="post" action="/espace/assurances/${escapeHtml(i.uid)}/supprimer"
                  data-confirm="${escapeHtml(`Supprimer le contrat ${i.provider} — ${i.productName} ?`)}">
              ${csrfField(o.csrf)}
              <button type="submit" class="btn-danger">Supprimer</button>
            </form>
          </span>
        </span>
      </li>`;
  }).join('\n')}
    </ul>`;

  /**
   * L'occasion d'économiser passe avant la liste des contrats : c'est la seule
   * information de cette page sur laquelle l'assuré peut agir tout de suite.
   */
  const opportunity = o.savings && o.savings.monthly > 0
    ? `    <div class="card opportunity">
      <span class="cap">Occasion d'économiser</span>
      <p class="figure">${money(o.savings.monthly)} <small>par mois</small></p>
      <p>soit <strong>${money(o.savings.yearly)} par an</strong> à couverture identique,
      en changeant d'assurance de base. Vos prestations légales ne changent pas :
      la LAMal est la même partout, seul le prix diffère.</p>
      <div class="actions">
        <a class="btn" href="/espace/optimisation">Voir combien je peux économiser</a>
      </div>
    </div>`
    : o.hasLamal
      ? ''
      : `    <div class="card">
      <h2>Optimiser votre assurance de base</h2>
      <p class="muted">Enregistrez votre contrat LAMal pour découvrir, sur les tarifs
      officiels de l'OFSP, combien votre foyer pourrait économiser.</p>
      <div class="actions">
        <a class="btn btn-ghost" href="/espace/assurances/nouvelle">Ajouter ma LAMal</a>
      </div>
    </div>`;

  return sitePage('Helvetik — Mes assurances', { email: o.email, active: 'assurances' },
    `    <h1>Mes assurances</h1>
    <p class="lead">${o.insurances.length} contrat(s) — ${money(o.monthlyTotal)} par mois au total.</p>
${messages({ notice: o.notice })}
${opportunity}
    <div class="card">
${body}
    </div>
    <div class="actions"><a class="btn" href="/espace/assurances/nouvelle">Ajouter un contrat</a></div>`);
}

export function renderInsuranceForm(o: {
  email: string;
  csrf: string;
  values: Values;
  insuredOptions: Array<[string, string]>;
  uid?: string;
  error?: string;
  info?: string;
  warnings?: string[];
  invalidFields?: string[];
  /** Caisses et modèles officiels de la région, pour remplacer la saisie libre. */
  catalogue?: LamalCatalogue;
}): string {
  const editing = Boolean(o.uid);
  const action = editing
    ? `/espace/assurances/${escapeHtml(o.uid!)}/modifier`
    : '/espace/assurances/nouvelle';

  return sitePage(`Helvetik — ${editing ? 'Modifier un contrat' : 'Ajouter un contrat'}`,
    { email: o.email, active: 'assurances' },
    `    <h1>${editing ? 'Modifier un contrat' : 'Ajouter un contrat'}</h1>
${messages(o)}
${editing ? '' : importBlock({
      action: '/espace/assurances/importer',
      csrf: o.csrf,
      hint: 'Déposez votre police en PDF ou photographiez votre carte d\'assuré : caisse, numéro de police, prime et franchise en seront extraits.'
    })}
    <form method="post" action="${action}" class="card" id="main-form"${invalidAttr(o.invalidFields)}>
      ${csrfField(o.csrf)}
${errorSummary()}
${insuranceFields(o.values, o.insuredOptions, formatDate(lamalPeriodEnd()), o.catalogue)}
${validationScript()}
      <div class="actions">
        <button type="submit">${editing ? 'Enregistrer' : 'Ajouter'}</button>
        <a class="link" href="/espace/assurances">Annuler</a>
      </div>
    </form>`);
}

export function insuranceToValues(insurance: IInsurance): Values {
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
    franchise: num(insurance.franchise),
    coverageAmount: num(insurance.coverageAmount),
    cancellationNoticeMonths: num(insurance.cancellationNoticeMonths),
    autoRenew: insurance.autoRenew,
    employerAccidentCoverage: insurance.employerAccidentCoverage,
    tariffType: insurance.tariffType || '',
    tariffCode: insurance.tariffCode || '',
    // Sélections du catalogue LAMal : les listes de choix se pré-remplissent
    // depuis la caisse et le modèle déjà enregistrés.
    lamalInsurerId: insurance.insurerId === undefined ? '' : String(insurance.insurerId),
    lamalTariffCode: insurance.tariffCode || ''
  };
}

export function clientToValues(client: IClient): Values {
  return {
    firstname: client.firstname,
    name: client.name,
    birthdate: toDateInputValue(client.birthdate),
    sexe: client.sexe,
    nationality: client.nationality,
    avsNum: client.avsNum,
    email: client.email,
    phone: client.phone,
    road: client.road,
    plz: client.plz,
    location: client.location,
    canton: client.canton
  };
}

// ----------------------------------------------------------- optimisation

/**
 * Écart par rapport au contrat actuel. Une économie s'affiche en vert, un
 * surcoût en rouge : sur un téléphone, c'est l'information qu'on cherche en
 * premier, avant même le prix.
 */
function deltaBlock(savings: number, hasCurrent: boolean): string {
  if (!hasCurrent) {
    return '';
  }
  if (savings < 0) {
    return `<span class="delta gain">− ${money(-savings)}/mois</span>`;
  }
  if (savings > 0) {
    return `<span class="delta loss">+ ${money(savings)}/mois</span>`;
  }
  return '<span class="delta same">Votre tarif actuel</span>';
}

/** Liste des meilleures offres pour le foyer entier, toutes chez la même caisse. */
function groupedList(result: OptimisationResult, limit: number): string {
  return result.offers.slice(0, limit).map((offer) => {
    const isCurrent = result.current?.insurerId === offer.insurerId &&
      result.current?.tariffCode === offer.tariffCode;

    return `        <li class="offer${isCurrent ? ' current' : ''}">
          <div class="who">${escapeHtml(offer.insurer)} <span class="model">— ${escapeHtml(modelLabel(offer))}</span></div>
          <div class="line">
            ${deltaBlock(offer.monthly.savings, Boolean(result.current))}
            <span class="price">${money(offer.monthly.total)} <small>/mois</small></span>
          </div>
        </li>`;
  }).join('\n');
}

/**
 * Répartition optimale : une ligne par assuré, encapsulée dans un bloc dont
 * l'en-tête porte le total combiné et qui se replie pour ne garder que lui.
 */
function individualBlock(result: OptimisationResult): string {
  const individual = result.individual!;

  const rows = individual.plans.map((plan) => `          <li class="offer plan">
            <div class="person">${escapeHtml(plan.name)}</div>
            <div class="who">${escapeHtml(plan.best.insurer)} <span class="model">— ${escapeHtml(modelLabel(plan.best))}</span></div>
            <div class="line">
              ${deltaBlock(-plan.savings.monthly, Boolean(plan.current))}
              <span class="price">${money(plan.best.monthly.total)} <small>/mois</small></span>
            </div>
          </li>`).join('\n');

  const caisses = individual.insurerCount === 1
    ? 'une seule caisse au final'
    : `${individual.insurerCount} caisses différentes`;

  return `      <details class="combo" open>
        <summary>
          <span class="combo-label">Total du foyer <small>(${escapeHtml(caisses)})</small></span>
          <span class="combo-total">${money(individual.monthly.total)} <small>/mois</small></span>
        </summary>
        <ul class="offers">
${rows}
        </ul>
      </details>
      <p class="muted">Chaque assuré est placé chez la caisse la moins chère pour lui.
      Les primes de l'assurance de base sont fixées par personne : réunir la famille chez
      un même assureur n'ouvre droit à aucun rabais.</p>`;
}

export function renderOptimisation(o: {
  email: string;
  result: OptimisationResult;
  limit: number;
}): string {
  const { result } = o;
  const individual = result.individual;

  // L'accroche annonce le meilleur des deux scénarios : afficher l'économie
  // groupée alors que la répartition individuelle fait mieux la sous-estimerait.
  const bestSavings = individual && individual.savings.monthly > result.potentialSavings.monthly
    ? individual.savings
    : result.potentialSavings;

  /**
   * Accroche de la page. Pour un foyer, elle confronte les deux stratégies :
   * quatre encadrés, l'économie mensuelle et annuelle de chacune, la meilleure
   * en évidence. C'est l'arbitrage à rendre, il passe donc avant tout le reste.
   */
  const stat = (caption: string, value: number, label: string, best: boolean) =>
    `      <div class="stat${best ? ' accent' : ''}">
        <span class="cap">${escapeHtml(caption)}</span>
        <span class="value">${money(value)}</span>
        <span class="label">${escapeHtml(label)}</span>
      </div>`;

  let hero: string;
  if (bestSavings.monthly <= 0) {
    hero = '    <p class="msg ok">Votre contrat actuel est déjà le plus avantageux.</p>';
  } else if (!individual) {
    hero = `    <div class="stats" style="margin-bottom:1rem">
      <div class="stat accent">
        <span class="value">${money(bestSavings.monthly)}</span>
        <span class="label">d'économie par mois</span>
      </div>
      <div class="stat">
        <span class="value">${money(bestSavings.yearly)}</span>
        <span class="label">soit par an</span>
      </div>
    </div>`;
  } else {
    // À économie égale, la solution groupée l'emporte : elle est plus simple.
    const split = individual.extra.monthly > 0;
    const note = split
      ? `Répartir vos assurés rapporte <strong>${money(individual.extra.monthly)} de plus par mois</strong>, ` +
        `soit ${money(individual.extra.yearly)} par an. Nous nous chargeons des résiliations et des ` +
        'affiliations auprès de chaque caisse : vous n\'avez qu\'un interlocuteur.'
      : 'Les deux stratégies aboutissent au même montant : la caisse la moins chère est la même ' +
        'pour chaque assuré du foyer.';

    hero = `    <div class="stats stats-4" style="margin-bottom:.75rem">
${stat('Même caisse pour tous', result.potentialSavings.monthly, 'd\'économie par mois', !split)}
${stat('Même caisse pour tous', result.potentialSavings.yearly, 'soit par an', !split)}
${stat('Chacun sa caisse', individual.savings.monthly, 'd\'économie par mois', split)}
${stat('Chacun sa caisse', individual.savings.yearly, 'soit par an', split)}
    </div>
    <p class="muted" style="margin-bottom:1rem">${note}</p>`;
  }

  const current = result.current
    ? `      <p>Votre contrat : <strong>${escapeHtml(result.current.insurer)} — ${escapeHtml(modelLabel(result.current))}</strong>,
      ${money(result.current.monthly.total)} par mois pour l'ensemble du foyer.</p>`
    : '      <p class="muted">Contrat actuel non identifié : les offres sont affichées sans comparaison.</p>';

  const people = result.insured ?? [];

  /**
   * Passage à l'acte. La stratégie retenue est transmise à la page suivante :
   * l'assuré a fait un choix en consultant les onglets, le lui redemander
   * reviendrait à perdre l'information.
   */
  const strategy = individual && individual.extra.monthly > 0 ? 'INDIVIDUAL' : 'GROUPED';
  const subscribe = bestSavings.monthly > 0
    ? `    <div class="card cta">
      <h2>Passer à l'action</h2>
      <p>Vous pouvez engager le changement pour l'année prochaine. La résiliation de
      l'assurance de base doit parvenir à votre caisse actuelle <strong>avant fin
      novembre</strong> ; nous nous chargeons des courriers et du suivi
      ${individual && individual.insurerCount > 1
        ? 'auprès de chaque caisse concernée'
        : 'auprès de votre nouvelle caisse'}.</p>
      <div class="actions">
        <a class="btn" href="/espace/souscription?option=${strategy === 'INDIVIDUAL' ? 'individuel' : 'groupe'}">
          Souscrire à ces nouvelles assurances</a>
      </div>
      <p class="muted">Service en phase de test : la page suivante vous explique
      précisément où nous en sommes avant tout engagement.</p>
    </div>
`
    : '';

  const grouped = `      <ul class="offers">
${groupedList(result, o.limit)}
      </ul>`;

  // Onglets en CSS pur : deux boutons radio pilotent l'affichage, la page
  // reste utilisable sans JavaScript.
  const extra = individual && individual.extra.monthly > 0
    ? `<span class="badge">− ${money(individual.extra.monthly)}/mois</span>`
    : '';

  const offersSection = !individual
    ? `      <h2>Les offres les moins chères</h2>
${grouped}`
    : `      <h2>Les offres les moins chères</h2>
      <div class="tabset">
        <input type="radio" name="vue" id="vue-groupe" checked>
        <input type="radio" name="vue" id="vue-individuel">
        <div class="tablist">
          <label for="vue-groupe">Toute la famille<small>chez la même caisse</small></label>
          <label for="vue-individuel">Chacun sa caisse${extra}<small>répartition optimale</small></label>
        </div>
        <div class="panel panel-groupe">
${grouped}
        </div>
        <div class="panel panel-individuel">
${individualBlock(result)}
        </div>
      </div>`;

  return sitePage('Helvetik — Optimiser ma LAMal', { email: o.email, active: 'optimisation' },
    `    <h1>Optimiser mon assurance de base</h1>
    <p class="lead">Primes ${result.year} pour ${escapeHtml(result.location.label)} —
    région ${result.location.region}, canton ${escapeHtml(result.location.canton)}.</p>
${hero}
${messages({ warnings: result.warnings })}
    <div class="card">
      <h2>Situation actuelle</h2>
${current}
      <p class="muted">Les montants affichés sont ceux que vous payez réellement : la
      redistribution de la taxe environnementale, ${money(result.redistributionYearly / 12)} par
      assuré et par mois, en est déjà déduite.</p>
    </div>

    <div class="card">
${offersSection}
      <p class="muted">Tarifs officiels de l'Office fédéral de la santé publique, millésime
      ${result.year}.</p>
    </div>
${subscribe}
    <div class="card">
      <h2>Sur quelles bases ce calcul est fait</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Assuré</th><th>Année de naissance</th><th class="num">Franchise</th><th>Couverture accident</th></tr>
          </thead>
          <tbody>
${people.map((p) => `            <tr>
              <td>${escapeHtml(p.name)}</td>
              <td>${p.yob}</td>
              <td class="num">${p.franchise} CHF</td>
              <td>${p.coverage === 1
                ? '<strong>Incluse</strong> dans la prime'
                : 'Couverte par l\'employeur, <strong>exclue</strong> de la prime'}</td>
            </tr>`).join('\n')}
          </tbody>
        </table>
      </div>
      <p class="muted">La couverture accident pèse une quinzaine de francs par mois. Si vous
      travaillez plus de 8 heures par semaine, votre employeur vous couvre et elle doit être
      exclue — sinon la comparaison surestime vos primes.</p>
      <div class="actions"><a class="btn btn-ghost" href="/espace/assurances">Corriger mes contrats</a></div>
    </div>`);
}

// ---------------------------------------------------------- souscription

/**
 * Page de souscription — en réalité, page d'information et de recueil d'avis.
 *
 * Le produit est en test : aucune assurance n'est souscrite. Le dire d'emblée,
 * clairement et avant toute autre chose, est une obligation autant qu'une
 * question de confiance ; l'assuré arrive ici en croyant s'engager.
 */
export function renderSubscription(o: {
  email: string;
  csrf: string;
  values: Values;
  savings?: { monthly: number; yearly: number } | null;
  strategy?: string;
  error?: string;
  invalid?: string[];
}): string {
  const strategyLabel = o.strategy === 'INDIVIDUAL'
    ? 'la répartition par assuré'
    : o.strategy === 'GROUPED' ? 'le regroupement chez une même caisse' : '';

  const recap = o.savings && o.savings.monthly > 0
    ? `      <p>D'après vos contrats, vous pourriez économiser
      <strong>${money(o.savings.monthly)} par mois</strong>, soit ${money(o.savings.yearly)} par an${
      strategyLabel ? `, en retenant ${strategyLabel}` : ''}.</p>`
    : '';

  return sitePage('Helvetik — Souscrire', { email: o.email, active: 'optimisation' },
    `    <h1>Avant d'aller plus loin</h1>
    <div class="msg warn">
      <strong>Aucune assurance ne sera souscrite aujourd'hui.</strong>
      Helvetik est en phase de test : le comparateur fonctionne sur les tarifs officiels
      de l'OFSP, mais la souscription et la résiliation ne sont pas encore ouvertes.
      Rien de ce que vous faites ici n'engage votre couverture actuelle, qui reste
      inchangée.
    </div>
${messages({ error: o.error })}
    <div class="card">
      <h2>Où en est le service</h2>
${recap}
      <p>Ce que vous voyez est un prototype complet du calcul : les primes, les modèles
      et la redistribution de la taxe environnementale sont les vrais chiffres 2026.
      Ce qui manque, c'est la partie contractuelle — mandat de résiliation, signature,
      transmission à la caisse — qui demande des accords que nous mettons en place.</p>
      <p>Si le service vous intéresse, vous pouvez demander à faire partie des
      <strong>premiers bêta-testeurs pour le changement de caisse de cette année</strong>.
      Les places sont limitées et nous accompagnons chaque dossier individuellement.</p>
    </div>

    <form method="post" action="/espace/souscription" novalidate${invalidAttr(o.invalid)}>
      ${csrfField(o.csrf)}
      <input type="hidden" name="strategy" value="${escapeHtml(o.strategy ?? '')}">
      <input type="hidden" name="savingsMonthly" value="${escapeHtml(String(o.savings?.monthly ?? ''))}">
${errorSummary()}
      <div class="card">
        <h2>Votre avis nous est utile</h2>
        <p class="muted">Trois minutes de réponses honnêtes valent mieux que cent
        suppositions de notre part. Les critiques nous servent plus que les compliments.</p>

${radios(o.values, 'interest', 'Un tel service vous intéresserait-il ?', [
      ['OUI', INTEREST_LABELS.OUI],
      ['PEUT_ETRE', INTEREST_LABELS.PEUT_ETRE],
      ['NON', INTEREST_LABELS.NON]
    ])}

${text(o.values, 'priceExpectation', 'Combien vous paraîtrait-il juste de payer pour ce service ?',
      'placeholder="par exemple : 30 CHF par an, ou une commission sur l\'économie réalisée"', false)}
        <p class="muted" style="margin-top:-.7rem">Répondez librement : un montant, un principe
        de facturation, ou « rien, cela devrait être gratuit ». Aucune réponse n'est mauvaise.</p>
      </div>

      <div class="card">
        <h2>Le changement de caisse de cette année</h2>
${checkbox(o.values, 'betaTester',
      'Je souhaite faire partie des premiers bêta-testeurs cette année.')}
${checkbox(o.values, 'recontact',
      'Vous pouvez me recontacter pour le changement de prime de cette année.')}
${text(o.values, 'contactPhone', 'Téléphone (facultatif, si vous préférez être appelé)', '', false)}
        <p class="muted" style="margin-top:-.7rem">Sans votre accord, nous ne vous
        recontacterons pas et vos coordonnées ne serviront qu'à votre compte.
        L'échéance de résiliation de la LAMal tombe fin novembre.</p>
      </div>

      <div class="card">
        <h2>L'interface</h2>
${radios(o.values, 'experienceRating', 'Comment avez-vous trouvé l\'expérience, dans l\'ensemble ?', [
      ['5', '5 — très claire, je n\'ai rien cherché'],
      ['4', '4 — bonne, quelques hésitations'],
      ['3', '3 — correcte, mais perfectible'],
      ['2', '2 — difficile, je me suis perdu'],
      ['1', '1 — confuse, je n\'ai pas obtenu ce que je voulais']
    ], { required: false })}

${textarea(o.values, 'experienceComment',
      'Qu\'est-ce qui vous a gêné, surpris ou fait hésiter ?',
      { rows: 4, placeholder: 'Soyez direct : c\'est ce qui nous aide le plus.' })}

${textarea(o.values, 'improvements',
      'Que faudrait-il ajouter ou changer pour que vous utilisiez ce service ?',
      { rows: 4, placeholder: 'Une fonction qui manque, une étape de trop, un chiffre incompréhensible…' })}

        <div class="actions">
          <button type="submit">Envoyer ma réponse</button>
          <a class="link" href="/espace/optimisation">Retour aux offres</a>
        </div>
      </div>
    </form>
${validationScript()}`);
}

export function renderSubscriptionThanks(o: {
  email: string;
  betaTester: boolean;
  recontact: boolean;
}): string {
  const next = o.betaTester
    ? `      <p>Vous êtes inscrit sur la liste des bêta-testeurs. Nous reviendrons vers vous
      à <strong>${escapeHtml(o.email)}</strong> avant l'échéance de fin novembre, dès que la
      souscription sera ouverte.</p>`
    : o.recontact
      ? `      <p>Nous vous recontacterons à <strong>${escapeHtml(o.email)}</strong> au moment du
      changement de prime de cette année.</p>`
      : '      <p>Nous ne vous recontacterons pas : vous ne nous l\'avez pas demandé.</p>';

  return sitePage('Helvetik — Merci', { email: o.email, active: 'optimisation' },
    `    <h1>Merci</h1>
    <div class="card">
      <p class="msg ok">Votre réponse est enregistrée.</p>
${next}
      <p class="muted">Rappel : aucune assurance n'a été souscrite ni résiliée. Votre
      couverture actuelle est inchangée.</p>
      <div class="actions">
        <a class="btn" href="/espace/optimisation">Revoir mes offres</a>
        <a class="btn btn-ghost" href="/espace">Retour à mon espace</a>
      </div>
    </div>`);
}

export function renderOptimisationUnavailable(o: {
  email: string;
  title: string;
  message: string;
  action?: { href: string; label: string };
}): string {
  return sitePage('Helvetik — Optimiser ma LAMal', { email: o.email, active: 'optimisation' },
    `    <h1>Optimiser mon assurance de base</h1>
    <div class="card">
      <p class="msg info">${escapeHtml(o.message)}</p>
      ${o.action ? `<div class="actions"><a class="btn" href="${o.action.href}">${escapeHtml(o.action.label)}</a></div>` : ''}
    </div>`);
}
