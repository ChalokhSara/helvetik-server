/**
 * Blocs de formulaire réutilisés par le site : identité d'un assuré, contrat.
 */

import { CANTONS } from '../../models/client.model';
import {
  INSURANCE_STATUSES,
  INSURANCE_TYPES,
  PREMIUM_FREQUENCIES,
  TARIFF_TYPES,
  TARIFF_TYPE_LABELS
} from '../../models/insurance.model';
import { escapeHtml } from './layout';

export const TYPE_LABELS: Record<string, string> = {
  LAMAL: 'LAMal — assurance de base',
  COMPLEMENTAIRE_SANTE: 'Complémentaire santé',
  ACCIDENT: 'Accident',
  INDEMNITE_JOURNALIERE: 'Indemnité journalière',
  VIE: 'Vie / 3e pilier',
  RC_PRIVEE: 'Responsabilité civile privée',
  MENAGE: 'Ménage',
  BATIMENT: 'Bâtiment',
  VEHICULE: 'Véhicule',
  PROTECTION_JURIDIQUE: 'Protection juridique',
  VOYAGE: 'Voyage',
  ANIMAUX: 'Animaux',
  AUTRE: 'Autre'
};

export const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'En vigueur',
  PENDING: 'À venir',
  EXPIRED: 'Échue',
  CANCELLED: 'Résiliée'
};

export const FREQUENCY_LABELS: Record<string, string> = {
  MENSUEL: 'Mensuel',
  TRIMESTRIEL: 'Trimestriel',
  SEMESTRIEL: 'Semestriel',
  ANNUEL: 'Annuel'
};

const SEXES: Array<[string, string]> = [
  ['F', 'Féminin'],
  ['M', 'Masculin'],
  ['X', 'Autre']
];

export type Values = Record<string, string | boolean | undefined>;

/** Emplacement du récapitulatif d'erreurs, en tête de formulaire. */
export function errorSummary(): string {
  return '      <div class="msg err" id="form-errors" role="alert" tabindex="-1" hidden></div>';
}

/**
 * Validation visible du formulaire.
 *
 * Le navigateur bloque déjà l'envoi d'un formulaire incomplet, mais sa bulle
 * disparaît au moindre défilement et ne signale qu'un champ à la fois : sur un
 * long formulaire, on a l'impression que le bouton ne fait rien. On reprend
 * donc la main — `novalidate` désactive la bulle native — pour marquer tous
 * les champs fautifs d'un coup, les cercler de rouge et les récapituler.
 *
 * Sans JavaScript, la validation native reprend simplement ses droits.
 */
export function validationScript(): string {
  return `      <script>
        (function () {
          var form = document.getElementById('main-form');
          var summary = document.getElementById('form-errors');
          if (!form || !summary) { return; }
          form.setAttribute('novalidate', 'novalidate');

          function labelOf(el) {
            var label = el.id ? form.querySelector('label[for="' + el.id + '"]') : null;
            return label ? label.textContent.replace(/\\s+/g, ' ').trim() : (el.name || 'Ce champ');
          }

          function reason(el) {
            if (el.validity.valueMissing) { return 'Ce champ est obligatoire.'; }
            if (el.validity.patternMismatch) { return 'Le format attendu n\\'est pas respecté.'; }
            if (el.validity.typeMismatch) { return 'La valeur saisie n\\'est pas valide.'; }
            if (el.validity.rangeUnderflow || el.validity.rangeOverflow) { return 'La valeur est hors des limites.'; }
            return el.validationMessage || 'Valeur invalide.';
          }

          function clear(el) {
            el.classList.remove('invalid');
            el.removeAttribute('aria-invalid');
            var holder = el.parentElement;
            var note = holder && holder.querySelector('.field-error');
            if (note) { note.remove(); }
          }

          function mark(el) {
            el.classList.add('invalid');
            el.setAttribute('aria-invalid', 'true');
            var holder = el.parentElement;
            if (!holder || holder.querySelector('.field-error')) { return; }
            var note = document.createElement('p');
            note.className = 'field-error';
            note.textContent = reason(el);
            holder.appendChild(note);
          }

          function invalidFields() {
            return [].filter.call(form.elements, function (el) {
              return el.willValidate && !el.checkValidity();
            });
          }

          function report(fields) {
            summary.textContent = '';
            var title = document.createElement('strong');
            title.textContent = fields.length === 1
              ? 'Un champ doit être complété ou corrigé'
              : fields.length + ' champs doivent être complétés ou corrigés';
            summary.appendChild(title);

            var list = document.createElement('ul');
            fields.forEach(function (el) {
              var item = document.createElement('li');
              // textContent, jamais innerHTML : les libellés viennent du document.
              item.textContent = labelOf(el) + ' — ' + reason(el);
              list.appendChild(item);
            });
            summary.appendChild(list);
            summary.hidden = false;
          }

          form.addEventListener('submit', function (event) {
            [].forEach.call(form.elements, function (el) { if (el.willValidate) { clear(el); } });
            var fields = invalidFields();
            if (!fields.length) { summary.hidden = true; return; }

            event.preventDefault();
            fields.forEach(mark);
            report(fields);
            // Défensif : un navigateur ancien peut ne pas offrir ces méthodes,
            // et l'exception ferait perdre le marquage déjà posé.
            if (summary.scrollIntoView) {
              summary.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
            try { fields[0].focus({ preventScroll: true }); } catch (e) { fields[0].focus(); }
          });

          // Le marquage disparaît dès que le champ redevient correct.
          ['input', 'change'].forEach(function (type) {
            form.addEventListener(type, function (event) {
              var el = event.target;
              if (el.willValidate && el.checkValidity()) { clear(el); }
            });
          });

          // Champs refusés par le serveur, signalés au rechargement.
          var rejected = (form.getAttribute('data-invalid') || '').split(/[\\s,]+/).filter(Boolean);
          rejected.forEach(function (name) {
            var el = form.elements[name];
            if (el && el.classList) { el.classList.add('invalid'); el.setAttribute('aria-invalid', 'true'); }
          });
          if (rejected.length) {
            var first = form.elements[rejected[0]];
            if (first && first.focus) { first.focus({ preventScroll: true }); }
          }
        })();
      </script>`;
}

/**
 * Dépôt d'un document pour pré-remplir le formulaire.
 *
 * `capture="environment"` ouvre directement l'appareil photo arrière sur
 * mobile, tout en laissant le choix d'un fichier existant sur ordinateur.
 */
export function importBlock(options: { action: string; csrf: string; hint: string }): string {
  return `    <details class="card" style="margin-bottom:1rem">
      <summary style="cursor:pointer;font-weight:600">Gagner du temps : partir d'une photo ou d'un document</summary>
      <p class="muted">${escapeHtml(options.hint)}</p>
      <form method="post" action="${options.action}" enctype="multipart/form-data" id="import-form">

        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf)}">

        <!-- Prise de vue dans la page. Masquée tant que la caméra n'est pas
             utilisable : le champ fichier ci-dessous suffit alors. -->
        <div class="camera" id="camera" hidden>
          <div class="stage" id="stage">
            <video id="preview" playsinline muted></video>
            <img class="shot" id="shot" alt="Photo prise">
            <div class="frame"></div>
          </div>
          <div class="row">
            <button type="button" id="cam-open">Prendre une photo</button>
            <button type="button" id="cam-shoot" hidden>Capturer</button>
            <button type="button" id="cam-retry" class="btn-ghost" hidden>Reprendre</button>
            <button type="button" id="cam-close" class="btn-ghost" hidden>Fermer la caméra</button>
          </div>
          <p class="muted" id="cam-status"></p>
        </div>

        <!-- Volontairement non obligatoire : le champ est masqué tant que le
             bloc est replié, et un champ obligatoire invisible fait échouer la
             validation du navigateur sans qu'aucun message ne soit affichable.
             L'absence de fichier est signalée par le serveur. -->
        <label for="document">Ou choisir un fichier</label>
        <input id="document" name="document" type="file"
               accept="image/*,application/pdf" capture="environment">

        <div class="actions">
          <button type="submit">Analyser le document</button>
        </div>
      </form>
      <p class="muted">Le fichier est analysé puis supprimé : il n'est jamais conservé.
      Les champs reconnus restent à vérifier avant enregistrement.</p>

      <script>
        (function () {
          var camera = document.getElementById('camera');
          var input = document.getElementById('document');
          if (!camera || !input) { return; }

          // getUserMedia n'existe qu'en contexte sécurisé (HTTPS ou localhost),
          // et l'affectation d'un fichier au champ exige DataTransfer. Sans
          // l'un ou l'autre, on s'en tient au sélecteur de fichier.
          var usable = window.isSecureContext &&
            navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
            typeof DataTransfer !== 'undefined';
          if (!usable) { return; }
          camera.hidden = false;

          var stage = document.getElementById('stage');
          var video = document.getElementById('preview');
          var shot = document.getElementById('shot');
          var status = document.getElementById('cam-status');
          var open = document.getElementById('cam-open');
          var shoot = document.getElementById('cam-shoot');
          var retry = document.getElementById('cam-retry');
          var close = document.getElementById('cam-close');
          var stream = null;

          function show(a, b, c, d) {
            open.hidden = !a; shoot.hidden = !b; retry.hidden = !c; close.hidden = !d;
          }

          function stop() {
            if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
            stage.classList.remove('on', 'shot');
            show(true, false, false, false);
          }

          open.addEventListener('click', function () {
            status.textContent = 'Ouverture de la caméra…';
            navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1200 } },
              audio: false
            }).then(function (s) {
              stream = s;
              video.srcObject = s;
              video.play();
              stage.classList.add('on');
              stage.classList.remove('shot');
              show(false, true, false, true);
              status.textContent = 'Cadrez le document dans le rectangle, puis capturez.';
            }).catch(function (err) {
              status.textContent = err && err.name === 'NotAllowedError'
                ? "Accès à la caméra refusé. Autorisez-le, ou choisissez un fichier."
                : "Caméra indisponible sur cet appareil. Choisissez un fichier.";
            });
          });

          shoot.addEventListener('click', function () {
            var canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            shot.src = canvas.toDataURL('image/jpeg', 0.92);
            stage.classList.add('shot');
            show(false, false, true, true);

            canvas.toBlob(function (blob) {
              if (!blob) { status.textContent = 'La capture a échoué, réessayez.'; return; }
              var file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
              var data = new DataTransfer();
              data.items.add(file);
              input.files = data.files;
              status.textContent = 'Photo prête (' + Math.round(blob.size / 1024) + ' Ko). ' +
                'Lancez l\\'analyse, ou reprenez la photo.';
            }, 'image/jpeg', 0.92);

            // Le flux n'a plus d'utilité une fois l'image figée.
            if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
          });

          retry.addEventListener('click', function () { stop(); open.click(); });
          close.addEventListener('click', function () { stop(); status.textContent = ''; });

          // Ne pas laisser la caméra allumée en quittant la page.
          window.addEventListener('pagehide', stop);
          document.getElementById('import-form').addEventListener('submit', stop);
        })();
      </script>
    </details>`;
}

export function text(
  values: Values,
  name: string,
  label: string,
  attrs = '',
  required = true
): string {
  return `      <div>
        <label for="${name}">${escapeHtml(label)}</label>
        <input id="${name}" name="${name}" value="${escapeHtml(String(values[name] ?? ''))}" ${attrs}${required ? ' required' : ''}>
      </div>`;
}

export function textarea(
  values: Values,
  name: string,
  label: string,
  options: { rows?: number; placeholder?: string; required?: boolean } = {}
): string {
  return `      <div>
        <label for="${name}">${escapeHtml(label)}</label>
        <textarea id="${name}" name="${name}" rows="${options.rows ?? 4}"${
    options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : ''
  }${options.required ? ' required' : ''}>${escapeHtml(String(values[name] ?? ''))}</textarea>
      </div>`;
}

/**
 * Groupe de boutons radio.
 *
 * Préféré à une liste déroulante quand les options doivent être lues avant de
 * choisir : sur un téléphone, un `select` cache les réponses derrière un geste.
 */
export function radios(
  values: Values,
  name: string,
  legend: string,
  entries: Array<[string, string]>,
  options: { required?: boolean } = {}
): string {
  const current = String(values[name] ?? '');
  return `      <fieldset>
        <legend>${escapeHtml(legend)}</legend>
${entries.map(([value, label], index) => `        <div class="check">
          <input type="radio" id="${name}-${index}" name="${name}" value="${escapeHtml(value)}"${
    value === current ? ' checked' : ''
  }${options.required === false ? '' : ' required'}>
          <label for="${name}-${index}">${escapeHtml(label)}</label>
        </div>`).join('\n')}
      </fieldset>`;
}

/** Case à cocher isolée, dont l'état est conservé en cas de réaffichage. */
export function checkbox(
  values: Values,
  name: string,
  label: string,
  attrs = ''
): string {
  return `      <div class="check">
        <input type="checkbox" id="${name}" name="${name}" value="true"${
    values[name] ? ' checked' : ''
  }${attrs}>
        <label for="${name}">${escapeHtml(label)}</label>
      </div>`;
}

export function select(
  values: Values,
  name: string,
  label: string,
  entries: Array<[string, string]>,
  options: { placeholder?: string; required?: boolean } = {}
): string {
  const current = String(values[name] ?? '');
  const list = entries
    .map(([value, text_]) =>
      `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(text_)}</option>`)
    .join('\n          ');

  return `      <div>
        <label for="${name}">${escapeHtml(label)}</label>
        <select id="${name}" name="${name}"${options.required === false ? '' : ' required'}>
          ${options.placeholder ? `<option value="">${escapeHtml(options.placeholder)}</option>` : ''}
          ${list}
        </select>
      </div>`;
}

/** Adresse déjà connue du foyer, proposée par défaut pour un nouvel assuré. */
export interface HouseholdAddress {
  label: string;
  road: string;
  plz: string;
  location: string;
  canton: string;
}

/**
 * Case « même adresse que le foyer ».
 *
 * Les champs sont pré-remplis côté serveur : sans JavaScript, l'adresse est
 * donc déjà bonne et la case ne fait que documenter ce qui a été proposé.
 * Avec JavaScript, la décocher vide les champs, et toute saisie manuelle la
 * décoche — la case reflète toujours l'état réel du formulaire.
 */
function sameAddressBlock(address: HouseholdAddress, checked: boolean): string {
  const data = [
    `data-road="${escapeHtml(address.road)}"`,
    `data-plz="${escapeHtml(address.plz)}"`,
    `data-location="${escapeHtml(address.location)}"`,
    `data-canton="${escapeHtml(address.canton)}"`
  ].join(' ');

  return `      <div class="check">
        <input id="sameAddress" type="checkbox"${checked ? ' checked' : ''} ${data}>
        <label for="sameAddress">
          Même adresse que ${escapeHtml(address.label)}
          <span class="muted">— ${escapeHtml(address.road)}, ${escapeHtml(address.plz)} ${escapeHtml(address.location)}</span>
        </label>
      </div>`;
}

/**
 * Comportement de la case, émis **après** les champs d'adresse : un script
 * placé avant eux ne les trouverait pas et n'attacherait rien.
 */
function sameAddressScript(): string {
  return `      <script>
        (function () {
          var box = document.getElementById('sameAddress');
          if (!box) { return; }
          var fields = ['road', 'plz', 'location', 'canton'].map(function (n) {
            return { name: n, el: document.getElementById(n) };
          }).filter(function (f) { return f.el; });

          box.addEventListener('change', function () {
            fields.forEach(function (f) {
              f.el.value = box.checked ? (box.getAttribute('data-' + f.name) || '') : '';
            });
            if (!box.checked && fields.length) { fields[0].el.focus(); }
          });

          // Une adresse saisie à la main n'est plus celle du foyer.
          fields.forEach(function (f) {
            f.el.addEventListener('input', function () {
              if (box.checked && f.el.value !== (box.getAttribute('data-' + f.name) || '')) {
                box.checked = false;
              }
            });
          });
        })();
      </script>`;
}

/** L'adresse saisie est-elle encore celle du foyer ? */
function sameAsHousehold(values: Values, address: HouseholdAddress): boolean {
  return (["road", "plz", "location", "canton"] as const)
    .every((field) => String(values[field] ?? "") === address[field]);
}

/**
 * Identité et adresse d'un assuré.
 *
 * `requirePhone` n'est vrai qu'à l'inscription : le numéro du titulaire sert
 * de contact au compte. Pour les membres ajoutés ensuite — un enfant, un
 * conjoint — il est facultatif.
 */
export function insuredFields(
  values: Values,
  address?: HouseholdAddress,
  requirePhone = false
): string {
  return `    <fieldset>
      <legend>Identité</legend>
      <div class="grid">
${text(values, 'firstname', 'Prénom', 'type="text" autocomplete="given-name"')}
${text(values, 'name', 'Nom', 'type="text" autocomplete="family-name"')}
${text(values, 'birthdate', 'Date de naissance', 'type="date" max="9999-12-31"')}
${select(values, 'sexe', 'Sexe', SEXES, { placeholder: '— Choisir —' })}
${text(values, 'nationality', 'Nationalité', 'type="text" placeholder="CH"')}
${text(values, 'avsNum', 'N° AVS', 'type="text" inputmode="numeric" placeholder="756.1234.5678.90" pattern="756\\.\\d{4}\\.\\d{4}\\.\\d{2}"')}
      </div>
      <p class="muted">Le numéro AVS figure sur votre carte d'assurance, au format 756.XXXX.XXXX.XX.</p>
    </fieldset>

    <fieldset>
      <legend>Contact et adresse</legend>
      <div class="grid">
${text(values, 'email', 'Email', 'type="email" autocomplete="email"')}
${text(values, 'phone', requirePhone ? 'Téléphone' : 'Téléphone (facultatif)',
  'type="tel" autocomplete="tel" placeholder="+41 79 123 45 67"', requirePhone)}
      </div>
${address ? sameAddressBlock(address, sameAsHousehold(values, address)) : ''}
${text(values, 'road', 'Rue et numéro', 'type="text" autocomplete="street-address"')}
      <div class="grid">
${text(values, 'plz', 'NPA', 'type="text" inputmode="numeric" pattern="\\d{4}" placeholder="1000" autocomplete="postal-code"')}
${text(values, 'location', 'Localité', 'type="text" autocomplete="address-level2"')}
${select(values, 'canton', 'Canton', CANTONS.map((c) => [c, c] as [string, string]), { placeholder: '—' })}
      </div>
      <p class="muted">Le NPA et la localité déterminent votre région de primes : ils doivent être exacts.</p>
${address ? sameAddressScript() : ''}
    </fieldset>`;
}

/**
 * Champs d'un contrat.
 *
 * Les blocs marqués `data-when="LAMAL"` ou `data-when="AUTRE"` n'apparaissent
 * que pour le type correspondant : demander une somme assurée sur une LAMal, ou
 * un modèle HMO sur une assurance ménage, n'aurait aucun sens.
 *
 * Sans JavaScript, tout reste visible et le serveur ignore de toute façon les
 * champs hors sujet : la page fonctionne, elle est seulement plus bavarde.
 */
/** Catalogue transmis au formulaire, réduit à ce dont l'affichage a besoin. */
export interface LamalCatalogue {
  year: number;
  location: { label: string; canton: string; region: number; plz: string };
  insurers: Array<{
    insurerId: number;
    name: string;
    tariffs: Array<{ tariffCode: string; tariffType: string; label: string }>;
  }>;
}

/** Franchises légales, tous âges confondus, dédoublonnées et ordonnées. */
const ALL_FRANCHISES = [0, 100, 200, 300, 400, 500, 600, 1000, 1500, 2000, 2500];

/**
 * Choix de la caisse, du modèle et de la franchise dans le catalogue officiel.
 *
 * Tous les modèles de la région sont écrits dans la page, chacun portant la
 * caisse à laquelle il appartient. Le script ne fait que masquer ceux qui ne
 * correspondent pas à la caisse choisie : sans JavaScript, la liste complète
 * reste utilisable, chaque modèle étant préfixé du nom de sa caisse.
 */
function lamalCatalogueFields(values: Values, catalogue?: LamalCatalogue): string {
  if (!catalogue || !catalogue.insurers.length) {
    // Repli : sans tarifs importés, on ne peut que redemander la saisie libre.
    return `        <p class="msg warn">Les tarifs officiels ne sont pas disponibles pour votre
        région : saisissez votre caisse et votre modèle à la main.</p>
        <div class="grid">
${text(values, 'provider', 'Caisse', 'type="text" placeholder="CSS, Assura, Helsana…"')}
${text(values, 'tariffCode', 'Modèle', 'type="text" placeholder="CareMed"', false)}
        </div>
${text(values, 'franchise', 'Franchise annuelle', 'type="number" min="0" step="100" inputmode="numeric"', false)}`;
  }

  const currentInsurer = String(values.lamalInsurerId ?? '');
  const currentTariff = String(values.lamalTariffCode ?? '');

  const insurerOptions = catalogue.insurers
    .map((insurer) => `          <option value="${insurer.insurerId}"${
      String(insurer.insurerId) === currentInsurer ? ' selected' : ''
    }>${escapeHtml(insurer.name)}</option>`)
    .join('\n');

  const tariffOptions = catalogue.insurers
    .flatMap((insurer) => insurer.tariffs.map((tariff) =>
      `          <option value="${escapeHtml(tariff.tariffCode)}" data-insurer="${insurer.insurerId}"${
        tariff.tariffCode === currentTariff && String(insurer.insurerId) === currentInsurer
          ? ' selected'
          : ''
      }>${escapeHtml(insurer.name)} — ${escapeHtml(tariff.label)}</option>`))
    .join('\n');

  const franchiseOptions = ALL_FRANCHISES
    .map((value) => `          <option value="${value}"${
      String(value) === String(values.franchise ?? '') ? ' selected' : ''
    }>${value} CHF</option>`)
    .join('\n');

  return `        <div class="grid">
          <div>
            <label for="lamalInsurerId">Votre caisse</label>
            <select id="lamalInsurerId" name="lamalInsurerId">
              <option value="">— Choisir —</option>
${insurerOptions}
            </select>
          </div>
          <div>
            <label for="lamalTariffCode">Votre modèle</label>
            <select id="lamalTariffCode" name="lamalTariffCode">
              <option value="">— Choisir —</option>
${tariffOptions}
            </select>
          </div>
        </div>

        <div class="grid">
          <div>
            <label for="franchise">Franchise annuelle</label>
            <select id="franchise" name="franchise">
              <option value="">— Choisir —</option>
${franchiseOptions}
            </select>
          </div>
          <div>
            <label for="lamal-premium">Prime mensuelle</label>
            <output id="lamal-premium" class="readout">—</output>
          </div>
        </div>

        <div class="check">
          <input id="employerAccidentCoverage" name="employerAccidentCoverage" type="checkbox" value="true"${
    values.employerAccidentCoverage ? ' checked' : ''
  }>
          <label for="employerAccidentCoverage">
            Je suis couvert contre les accidents par mon employeur
            <span class="muted">— si vous travaillez plus de 8 h par semaine, la couverture
            accident est retirée de votre LAMal, ce qui réduit la prime.</span>
          </label>
        </div>
        <p class="muted">Caisses et modèles proposés dans votre région d'après les tarifs
        officiels ${catalogue.year} de l'OFSP. De 300 à 2500 francs de franchise pour un
        adulte, de 0 à 600 pour un enfant.</p>`;
}

/**
 * Filtre les modèles selon la caisse choisie, et affiche la prime officielle
 * dès que les critères suffisent. Purement cosmétique : le serveur refait le
 * même calcul à l'enregistrement, sans faire confiance à ce qui est affiché.
 */
function lamalCatalogueScript(): string {
  return `
    <script>
      (function () {
        var insurer = document.getElementById('lamalInsurerId');
        var model = document.getElementById('lamalTariffCode');
        var franchise = document.getElementById('franchise');
        var client = document.getElementById('clientUid');
        var accident = document.getElementById('employerAccidentCoverage');
        var readout = document.getElementById('lamal-premium');
        if (!insurer || !model || !readout) { return; }

        function filterModels() {
          var wanted = insurer.value;
          var keep = null;
          Array.prototype.forEach.call(model.options, function (option) {
            if (!option.value) { return; }
            var match = option.getAttribute('data-insurer') === wanted;
            option.hidden = !match;
            option.disabled = !match;
            if (match && option.value === model.value) { keep = option.value; }
          });
          if (!keep) { model.value = ''; }
        }

        var pending = 0;
        function refreshPremium() {
          if (!insurer.value || !model.value || !franchise.value || !client || !client.value) {
            readout.textContent = '—';
            return;
          }
          var params = new URLSearchParams({
            insurerId: insurer.value,
            tariffCode: model.value,
            franchise: franchise.value,
            clientUid: client.value,
            coverage: accident && accident.checked ? '0' : '1'
          });
          var ticket = ++pending;
          readout.textContent = '…';
          fetch('/espace/assurances/lamal/prime?' + params.toString(), {
            headers: { Accept: 'application/json' }
          })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (data) {
              // Une réponse arrivée après une saisie plus récente est périmée.
              if (ticket !== pending) { return; }
              readout.textContent = data && typeof data.monthly === 'number'
                ? data.monthly.toFixed(2) + ' CHF / mois'
                : 'Tarif introuvable pour ces critères';
            })
            .catch(function () { if (ticket === pending) { readout.textContent = '—'; } });
        }

        insurer.addEventListener('change', function () { filterModels(); refreshPremium(); });
        [model, franchise, client, accident].forEach(function (field) {
          if (field) { field.addEventListener('change', refreshPremium); }
        });

        if (insurer.value) { filterModels(); }
        refreshPremium();
      })();
    </script>`;
}

export function insuranceFields(
  values: Values,
  insuredOptions: Array<[string, string]>,
  periodEnd: string,
  catalogue?: LamalCatalogue
): string {
  return `    <fieldset>
      <legend>Contrat</legend>
${select(values, 'clientUid', 'Assuré', insuredOptions, { placeholder: '— Choisir —' })}
${select(values, 'type', 'Type d\'assurance', INSURANCE_TYPES.map((t) => [t, TYPE_LABELS[t]] as [string, string]), { placeholder: '— Choisir —' })}

      <div data-when="LAMAL">
${lamalCatalogueFields(values, catalogue)}
      </div>

      <div data-when="AUTRE">
        <div class="grid">
${text(values, 'provider', 'Caisse ou compagnie', 'type="text" placeholder="CSS, Assura, Helsana…"', false)}
${text(values, 'productName', 'Nom de l\'offre', 'type="text" placeholder="Primeo Basic"', false)}
        </div>
      </div>

${text(values, 'policyNumber', 'N° de police', 'type="text"')}
${text(values, 'description', 'Description', 'type="text"', false)}
    </fieldset>

    <fieldset>
      <legend>Durée</legend>
      <div class="grid">
${text(values, 'startDate', 'Début du contrat', 'type="date"')}
${select(values, 'status', 'Statut', INSURANCE_STATUSES.map((s) => [s, STATUS_LABELS[s]] as [string, string]))}
      </div>

      <div data-when="LAMAL">
        <p class="msg info">L'assurance de base court sur l'année civile : la période en cours
        s'achève le <strong>${escapeHtml(periodEnd)}</strong>, et la résiliation doit parvenir à
        votre caisse pour le <strong>30 novembre</strong>. Ces dates sont fixées par la loi,
        vous n'avez rien à saisir.</p>
      </div>

      <div data-when="AUTRE">
        <div class="grid">
${text(values, 'endDate', 'Fin de la période en cours', 'type="date"', false)}
${text(values, 'cancellationNoticeMonths', 'Préavis de résiliation (mois)', 'type="number" min="0" max="24" step="1"', false)}
        </div>
        <div class="check">
          <input id="autoRenew" name="autoRenew" type="checkbox" value="true"${values.autoRenew === false ? '' : ' checked'}>
          <label for="autoRenew">Le contrat se reconduit tacitement</label>
        </div>
        <p class="muted">Sur un contrat à reconduction tacite, indiquez le terme de la période en
        cours. C'est de cette date que dépendent vos rappels de résiliation.</p>
      </div>
    </fieldset>

    <fieldset>
      <legend>Montants</legend>
      <div data-when="AUTRE">
        <div class="grid">
${text(values, 'premiumAmount', 'Prime', 'type="number" min="0" step="0.05" inputmode="decimal"', false)}
${select(values, 'premiumFrequency', 'Périodicité', PREMIUM_FREQUENCIES.map((f) => [f, FREQUENCY_LABELS[f]] as [string, string]), { required: false })}
        </div>
${text(values, 'coverageAmount', 'Somme assurée', 'type="number" min="0" step="1"', false)}
      </div>

      <div data-when="LAMAL">
        <p class="msg info" id="lamal-premium-note">La prime est reprise du tarif officiel
        ${catalogue ? `${catalogue.year} pour ${escapeHtml(catalogue.location.label)}` : ''} :
        vous n'avez pas à la recopier depuis votre police.</p>
      </div>
    </fieldset>

    <script>
      // Affiche les blocs correspondant au type choisi. Les champs des blocs
      // masqués sont désactivés : sans cela, ils seraient tout de même soumis
      // et le serveur recevrait deux valeurs pour un même champ.
      (function () {
        var type = document.getElementById('type');
        if (!type) { return; }
        function apply() {
          var lamal = type.value === 'LAMAL';
          document.querySelectorAll('[data-when]').forEach(function (block) {
            var off = block.getAttribute('data-when') === 'LAMAL' ? !lamal : lamal;
            block.hidden = off;
            block.querySelectorAll('input, select, textarea').forEach(function (field) {
              field.disabled = off;
            });
          });
        }
        type.addEventListener('change', apply);
        apply();
      })();
    </script>
${catalogue ? lamalCatalogueScript() : ''}`;
}
