import {
  Catalogue,
  CatalogueInsurer,
  CatalogueTariff,
  premiumsByTariff
} from './premium-catalogue.service';

/**
 * Lecture d'une police d'assurance par un modèle de langage local.
 *
 * Les expressions régulières échouaient là où les polices sont le plus
 * variables : chaque caisse a sa mise en page, ses libellés, sa langue, et la
 * reconnaissance optique casse en plus les colonnes. Un modèle de langage lit
 * ce genre de document bien mieux qu'un motif — à condition de ne jamais lui
 * faire confiance.
 *
 * Trois règles tiennent tout le reste :
 *
 *   1. **Le modèle tourne en local** (Ollama, sur le réseau Docker interne).
 *      Une police porte le nom, l'adresse, le numéro AVS et le numéro de
 *      police d'une personne : cela ne part pas chez un tiers.
 *
 *   2. **Le contexte est une ressource rare.** Une police fait trois pages,
 *      dont deux de conditions générales, et le catalogue d'une région compte
 *      cinquante caisses. Tout envoyer dépasse la fenêtre du modèle, qui
 *      tronque alors *silencieusement* — en gardant la fin, donc en jetant les
 *      consignes. D'où l'extrait ciblé et les deux questions séparées.
 *
 *   3. **Sa réponse est une hypothèse, pas un résultat.** Tout ce qu'il rend
 *      est confronté au catalogue officiel de l'OFSP : une caisse inconnue,
 *      un modèle qui n'appartient pas à cette caisse ou une franchise illégale
 *      sont rejetés. Ce qui survit est proposé à l'assuré, qui relit.
 */

const DEFAULT_URL = 'http://ollama:11434';
const DEFAULT_MODEL = 'llama3.2:3b';
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Fenêtre de contexte demandée à Ollama.
 *
 * Sans ce réglage, Ollama s'en tient à 4096 jetons et n'en laisse qu'environ
 * 2050 à l'invite. Une police réelle plus le catalogue en font le double : la
 * troncature emportait consignes et catalogue — elle garde la fin de l'invite —
 * et le modèle recevait un bout de document sans savoir quoi en faire. C'était
 * la cause du « rien n'a pu être tiré de votre document » sur les vraies
 * polices, là où les documents de test, courts, passaient sans encombre.
 */
const NUM_CTX = 8192;

/** Extrait envoyé au modèle : au-delà, on ne gagne que du bruit juridique. */
const MAX_EXCERPT_CHARS = 3000;

/** Franchises légales, adultes et enfants confondus. */
const LEGAL_FRANCHISES = new Set([0, 100, 200, 300, 400, 500, 600, 1000, 1500, 2000, 2500]);

/** Bornes de vraisemblance d'une prime mensuelle LAMal, en francs. */
const MIN_PREMIUM = 30;
const MAX_PREMIUM = 1500;

export interface PolicyReading {
  insurerId?: number;
  insurerName?: string;
  tariffCode?: string;
  tariffLabel?: string;
  franchise?: number;
  /** Prime mensuelle en francs. */
  premiumAmount?: number;
  policyNumber?: string;
  avsNum?: string;
  /** Nom de la personne assurée, tel qu'imprimé : sert à la retrouver dans le foyer. */
  insuredName?: string;
  /** Sa date de naissance, au format ISO, quand la police la donne. */
  insuredBirthdate?: string;
  /** Début de validité du contrat, au format ISO. */
  startDate?: string;
  /**
   * Précisions utiles figurant sur la police sans avoir de champ dédié :
   * médecin coordonnateur et son adresse, réseau de soins, intermédiaire,
   * motif de mutation. Reportées dans la description du contrat.
   */
  notes?: string;
  /** Vrai quand la police indique que l'accident est couvert par l'employeur. */
  employerAccidentCoverage?: boolean;
  /** Ce que le modèle a proposé et que le catalogue a refusé. */
  warnings: string[];
  /** Champs effectivement retenus, pour l'expliquer à l'assuré. */
  recognised: string[];
}

function config() {
  return {
    url: (process.env.OLLAMA_URL || DEFAULT_URL).replace(/\/+$/, ''),
    model: process.env.OLLAMA_MODEL || DEFAULT_MODEL,
    timeout: Number.parseInt(process.env.OLLAMA_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS,
    enabled: process.env.OLLAMA_ENABLED !== 'false'
  };
}

export function isLlmEnabled(): boolean {
  return config().enabled;
}

/** Le modèle est-il chargé et joignable ? Utilisé au démarrage, sans bloquer. */
export async function checkLlmAvailability(): Promise<void> {
  const { url, model, enabled } = config();
  if (!enabled) {
    console.warn('[police] lecture par modèle de langage désactivée (OLLAMA_ENABLED=false).');
    return;
  }

  try {
    const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = await response.json() as { models?: Array<{ name?: string }> };
    const names = (body.models || []).map((m) => String(m.name || ''));
    // Ollama nomme « llama3.2:3b » ; une demande sans étiquette vise « :latest ».
    const wanted = model.includes(':') ? model : `${model}:latest`;

    if (names.some((name) => name === wanted || name === model)) {
      console.info(`[police] modèle ${model} prêt sur ${url}.`);
    } else {
      console.warn(
        `[police] modèle ${model} pas encore téléchargé sur ${url} ` +
        `(disponibles : ${names.join(', ') || 'aucun'}). ` +
        'Le service ollama-init s\'en charge ; en attendant, la lecture des polices ' +
        'se limite aux motifs textuels.'
      );
    }
  } catch (err) {
    console.warn(
      `[police] ${url} injoignable (${(err as Error).message}) : la lecture des polices ` +
      'se limite aux motifs textuels.'
    );
  }
}

// ------------------------------------------------------- extrait du document

/**
 * Lignes de prose juridique, à écarter.
 *
 * Une police de trois pages en consacre deux aux conditions générales. Ce
 * texte n'apporte rien — pire, il nomme des produits **non souscrits**
 * (« Conditions complémentaires : Médecin de famille ; MultiAccess ; TelMed »),
 * ce qui égare le modèle autant que la vérification qui suit.
 */
const BOILERPLATE = /^(conditions (g[ée]n[ée]rales|compl[ée]mentaires|de conclusion|z[ée]ro souci)|dur[ée]e du contrat|rabais sur les primes|protection et divulgation|service de facturation|assurance de protection juridique|la contribution obligatoire|d.[ée]ventuelles r[ée]ductions|allgemeine versicherungsbedingungen)/i;

/** Début de la partie complémentaire : au-delà, ce n'est plus de la LAMal. */
const LCA_START = /assurance compl[ée]mentaire\s*\(lca\)|assurances priv[ée]es|zusatzversicherung/i;

/** Repères de la partie LAMal. */
const LAMAL_START = /assurance de base|\blamal\b|\baos\b|obligatoire des soins|grundversicherung/i;

/**
 * Réduit une police à sa partie LAMal.
 *
 * Deux effets, tous deux nécessaires : l'invite tient dans la fenêtre du
 * modèle, et les montants de l'assurance complémentaire ne peuvent plus être
 * pris pour la prime de base — sur une police « zéro souci », la prime totale
 * de 388.15 vaut 328.90 de base et 59.25 de complémentaire.
 */
export function lamalExcerpt(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    // La prose juridique est longue et sans montants : elle n'aide jamais.
    .filter((line) => !BOILERPLATE.test(line))
    // Les renvois d'édition (« MultiAccess, édition 01.2020 ») prolongent les
    // conditions complémentaires sur plusieurs lignes. Ils citent des produits
    // que l'assuré n'a pas souscrits, et suffiraient à faire passer un mauvais
    // modèle pour attesté par le document.
    .filter((line) => !/[ée]dition \d{2}\.\d{4}|ausgabe \d{2}\.\d{4}/i.test(line))
    .filter((line) => !(line.length > 160 && !/\d/.test(line)));

  const start = lines.findIndex((line) => LAMAL_START.test(line));
  if (start === -1) {
    return lines.join('\n').slice(0, MAX_EXCERPT_CHARS);
  }

  // La partie complémentaire commence après : on s'arrête là. Les quelques
  // lignes qui précèdent sont conservées : elles portent souvent l'identité et
  // le numéro de client.
  const rest = lines.slice(start + 1);
  const stop = rest.findIndex((line) => LCA_START.test(line));
  const body = stop === -1 ? rest : rest.slice(0, stop);

  const header = lines.slice(Math.max(0, start - 12), start);
  return [...header, lines[start], ...body].join('\n').slice(0, MAX_EXCERPT_CHARS);
}

// --------------------------------------------------------- appel du modèle

interface AskResult<T> {
  value: T | null;
  /** Le modèle a-t-il dû tronquer l'invite ? Sa réponse est alors suspecte. */
  truncated: boolean;
}

async function ask<T>(prompt: string, maxTokens: number): Promise<AskResult<T>> {
  const { url, model, timeout } = config();

  const response = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      // Contraint la sortie à du JSON valide : sans cela, un modèle de 3
      // milliards de paramètres encadre volontiers sa réponse d'explications.
      format: 'json',
      options: {
        num_ctx: NUM_CTX,
        // Extraction, pas rédaction : on veut la réponse la plus probable,
        // reproductible d'un dépôt à l'autre.
        temperature: 0,
        num_predict: maxTokens
      }
    }),
    signal: AbortSignal.timeout(timeout)
  });

  if (!response.ok) {
    throw new Error(`Ollama a répondu HTTP ${response.status}`);
  }

  const body = await response.json() as { response?: string; prompt_eval_count?: number };

  // Contrôle de la place réellement consommée : au-delà de la fenêtre, Ollama
  // tronque en gardant la **fin** de l'invite, donc en jetant les consignes.
  // Mieux vaut le signaler que rendre une extraction faite à l'aveugle.
  const used = Number(body.prompt_eval_count || 0);
  const truncated = used > 0 && used >= NUM_CTX - maxTokens;
  if (truncated) {
    console.warn(
      `[police] invite de ${used} jetons pour une fenêtre de ${NUM_CTX} : ` +
      'la lecture a pu être tronquée.'
    );
  }

  const raw = String(body.response || '').trim();
  if (!raw) {
    return { value: null, truncated };
  }

  try {
    return { value: JSON.parse(raw) as T, truncated };
  } catch {
    // Ceinture et bretelles : `format: json` peut être ignoré par un modèle
    // ancien, on récupère alors le premier objet du texte.
    const match = raw.match(/\{[\s\S]*\}/);
    return { value: match ? JSON.parse(match[0]) as T : null, truncated };
  }
}

// ----------------------------------------------- première question : le gros

interface RawMain {
  insurerName?: unknown;
  franchise?: unknown;
  premiumAmount?: unknown;
  policyNumber?: unknown;
  avsNum?: unknown;
  accidentIncluded?: unknown;
  startDate?: unknown;
  notes?: unknown;
  insuredName?: unknown;
  insuredBirthdate?: unknown;
}

/**
 * Les caisses, sans leurs modèles.
 *
 * Cette liste seule fait déjà cinquante lignes ; y joindre les modèles de
 * chacune triplait l'invite et la faisait déborder. Le modèle d'assurance fait
 * donc l'objet d'une seconde question, une fois la caisse connue.
 *
 * Les noms seuls, sans identifiant : à qui on demande un numéro, un modèle de
 * langage répond volontiers un numéro *voisin* du bon — sur cette police,
 * 1507 (AMB) au lieu de 1509 (Sanitas). Un nom, lui, se recoupe avec le texte.
 */
function insurerList(catalogue: Catalogue): string {
  return catalogue.insurers.map((insurer) => insurer.name).join('\n');
}

/**
 * Retrouve une caisse à partir du nom rendu par le modèle.
 *
 * Deux conditions cumulatives : le nom doit désigner une caisse du catalogue,
 * et sa racine doit figurer dans le document. La seconde écarte le cas où le
 * modèle recopie une caisse de la liste sans qu'elle apparaisse nulle part.
 */
function resolveInsurer(
  name: string,
  catalogue: Catalogue,
  excerpt: string
): CatalogueInsurer | undefined {
  const key = tariffKey(name);
  if (key.length < 3) {
    return undefined;
  }

  // La présence dans le document se teste sur un texte qui garde ses
  // séparateurs, et mot entier. Sur la clé compactée, « assura » se trouve
  // dans « assurance-maladie » : toute police française passait alors pour un
  // contrat Assura, quelle que soit la caisse réellement imprimée dessus.
  const haystack = words(excerpt);
  const scored = catalogue.insurers
    .map((insurer) => {
      const full = tariffKey(insurer.name);
      // « Sanitas » dans « Sanitas Assurances de base SA » : la racine du nom
      // officiel est ce qui est imprimé sur le document.
      const root = tariffKey(insurer.name.split(/[\s-]+/)[0]);
      const matches = full === key || full.includes(key) || key.includes(root);
      return { insurer, root, matches };
    })
    .filter((c) => c.matches && c.root.length >= 3 && containsWord(haystack, c.root));

  // La racine la plus longue l'emporte : « Mutuel » est contenu dans plusieurs
  // raisons sociales, la plus spécifique est la bonne.
  return scored.sort((a, b) => b.root.length - a.root.length)[0]?.insurer;
}

function mainPrompt(excerpt: string, catalogue: Catalogue): string {
  return `Tu lis une police d'assurance maladie suisse (LAMal). Le texte vient d'un PDF ou
d'une reconnaissance optique : il peut être désordonné.

Extrais uniquement ce que le document contient. N'invente rien : un champ absent ou
illisible vaut null.

Caisses possibles :
${insurerList(catalogue)}

Champs :
- insurerName : le nom, recopié exactement depuis la liste ci-dessus, de la caisse qui
  émet cette police. Attention, le courtier ou l'intermédiaire cité n'est pas la caisse.
- franchise : la franchise annuelle en francs, entier parmi 0, 100, 200, 300, 400, 500,
  600, 1000, 1500, 2000, 2500. Les milliers s'écrivent parfois 2'500.
- premiumAmount : la prime MENSUELLE de l'assurance de BASE seule, en francs. Ignore
  l'assurance complémentaire et les totaux qui l'incluent. Si le document distingue une
  prime brute et un solde après déductions, retiens le SOLDE.
- policyNumber : le numéro de police, tel qu'écrit.
- avsNum : le numéro AVS au format 756.XXXX.XXXX.XX, ou null s'il n'y en a pas.
- insuredName : le nom et le prénom de la personne ASSURÉE, telle que nommée sur la
  police. Ni le courtier, ni le médecin, ni la caisse.
- insuredBirthdate : sa date de naissance au format AAAA-MM-JJ, ou null.
- accidentIncluded : true si le document dit la couverture accident INCLUSE, false s'il
  la dit exclue, non assurée, suspendue ou couverte par l'employeur, null s'il n'en parle pas.
- startDate : la date de début de validité du contrat, au format AAAA-MM-JJ. Elle suit
  des mentions comme « valable dès le », « début du contrat », « gültig ab ». Ce n'est ni
  la date d'édition du document, ni la date de signature.
- notes : une seule phrase, 200 caractères au maximum, reprenant les précisions utiles
  de la police qui n'ont pas de champ à elles — médecin ou centre coordonnateur avec son
  adresse, réseau de soins, intermédiaire, motif de mutation. N'invente rien ; null si le
  document n'en donne aucune.

Réponds par ce seul objet JSON :
{"insurerName":null,"franchise":null,"premiumAmount":null,"policyNumber":null,"avsNum":null,"insuredName":null,"insuredBirthdate":null,"accidentIncluded":null,"startDate":null,"notes":null}

Document :
"""
${excerpt}
"""`;
}

// ---------------------------------------- seconde question : le modèle choisi

interface RawTariff {
  tariffCode?: unknown;
}

function tariffPrompt(excerpt: string, insurer: CatalogueInsurer): string {
  const list = insurer.tariffs
    .map((t) => `${t.tariffCode} = ${t.label} (type ${t.tariffType})`)
    .join('\n');

  return `Ce document est une police d'assurance de base ${insurer.name}. Détermine quel
modèle d'assurance a été souscrit.

Modèles proposés par ${insurer.name} dans cette région :
${list}

Les intitulés commerciaux varient d'une langue à l'autre : « Médecin de famille » et
« Hausarztmodell » désignent le type HAM, « Telmed » et « CallMed » le type DIV,
« HMO » et « Managed Care » le type HMO. Le type BASE est le modèle standard, sans
restriction du choix du médecin.

Retiens le modèle réellement souscrit, celui qui porte le montant de la prime. Si le
document ne permet pas de trancher entre plusieurs, réponds null.

Réponds par ce seul objet JSON : {"tariffCode":null}

Document :
"""
${excerpt}
"""`;
}

// ------------------------------------------------------------- normalisation

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    // « 2'500.00 », « CHF 275.85 », « 1 234,50 »
    const cleaned = value.replace(/['’\s]|chf|fr\.?/gi, '').replace(',', '.');
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || /^(null|none|n\/a|inconnu|unknown)$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed.slice(0, max);
}

/**
 * Date rendue par le modèle, en ISO si elle est plausible.
 *
 * Deux écritures acceptées : l'ISO demandée, et le format suisse JJ.MM.AAAA
 * que le modèle recopie parfois du document malgré la consigne.
 */
function parseDate(value: string): string | undefined {
  const swiss = value.match(/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})$/);
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);

  const [year, month, day] = swiss
    ? [Number(swiss[3]), Number(swiss[2]), Number(swiss[1])]
    : iso
      ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      : [NaN, NaN, NaN];

  const thisYear = new Date().getUTCFullYear();
  if (!Number.isFinite(year) || year < 1996 || year > thisYear + 2) {
    return undefined;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== month - 1) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

/** Date de naissance : passée, et pas absurdement ancienne. */
function parseBirthdate(value: string): string | undefined {
  const swiss = value.match(/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})$/);
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);

  const [year, month, day] = swiss
    ? [Number(swiss[3]), Number(swiss[2]), Number(swiss[1])]
    : iso
      ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      : [NaN, NaN, NaN];

  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== month - 1 ||
      year < 1900 || date.getTime() > Date.now()) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

/** Comparaison insensible à la ponctuation : « KPTwin.doc » vaut « KPTwindoc ». */
function tariffKey(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Même normalisation, mais les séparateurs deviennent des espaces au lieu de
 * disparaître. Indispensable pour chercher un mot entier : la clé compactée
 * confond « Assura » avec le mot « assurance ».
 */
function words(value: string): string {
  return ` ${value.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** Le mot figure-t-il en entier dans un texte déjà passé par `words()` ? */
function containsWord(haystack: string, word: string): boolean {
  return haystack.includes(` ${word} `);
}

/**
 * Famille de modèle nommée dans le document, indépendamment de la langue.
 *
 * Une police française dit « Médecin de famille » là où le catalogue de l'OFSP
 * écrit « Hausarztmodell 1 » : aucun mot commun. Le type de modèle, lui, est le
 * même — c'est par lui que les deux se rejoignent.
 */
function familyInText(text: string): CatalogueTariff['tariffType'] | undefined {
  const haystack = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  if (/\bhmo\b|managed care|centre de sante|gesundheitszentrum/.test(haystack)) {
    return 'HMO';
  }
  if (/medecin de famille|hausarzt|medico di famiglia|fournisseur de prestations coordonnant/.test(haystack)) {
    return 'HAM';
  }
  if (/telmed|tel med|callmed|telemedecine|conseil telephonique|telefonische/.test(haystack)) {
    return 'DIV';
  }
  return undefined;
}

/**
 * Le modèle retenu laisse-t-il une trace dans le document ?
 *
 * Garde-fou indispensable, et le seul qui attrape la faute la plus coûteuse :
 * confronté à un modèle qu'il ne trouve pas, un modèle de langage préfère en
 * proposer un autre plutôt que de renoncer. Le catalogue ne peut pas le
 * démentir — la valeur inventée y figure bel et bien.
 *
 * Deux façons d'établir la trace :
 *   - le nom commercial ou le code apparaît dans l'extrait ;
 *   - le document nomme une famille de modèle (« médecin de famille ») et la
 *     caisse n'en propose **qu'un seul** de ce type, ce qui lève l'ambiguïté.
 *
 * Le modèle standard est exempté : une police qui ne nomme rien en relève, et
 * « assurance de base » n'est jamais imprimé comme nom de produit.
 */
function tariffIsSupported(
  tariff: CatalogueTariff,
  insurer: CatalogueInsurer,
  excerpt: string
): boolean {
  const family = familyInText(excerpt);

  if (tariff.tariffType === 'BASE') {
    // Le standard n'est le bon choix que si le document ne nomme aucun modèle.
    // Sans cette réserve, une police « médecin de famille » passait pour du
    // standard sans que rien ne le signale — et le standard est le plus cher
    // des modèles, ce qui fausse l'économie annoncée dans le mauvais sens.
    return family === undefined;
  }

  const haystack = tariffKey(excerpt);
  const named = [tariff.tariffCode, tariff.label]
    .flatMap((value) => [value, ...value.split(/[\s\-/()]+/)])
    .map(tariffKey)
    .filter((key) => key.length >= 5)
    .some((key) => haystack.includes(key));

  if (named) {
    return true;
  }

  if (family && family === tariff.tariffType) {
    return insurer.tariffs.filter((t) => t.tariffType === family).length === 1;
  }

  return false;
}

/**
 * Proportion de mots où un chiffre s'est glissé au milieu des lettres.
 *
 * Signature caractéristique d'une reconnaissance optique en difficulté : sur
 * un scan réel, tous les « c » étaient devenus des « 8 », donnant
 * « Modifi8ation d'assuran8e ». Aucun mot français ne s'écrit ainsi, et le
 * repère est donc fiable — là où compter les mots inconnus d'un dictionnaire
 * confondrait un document abîmé avec un document en allemand.
 */
function ocrDamage(text: string): number {
  const words = text.split(/\s+/).filter((word) => word.length >= 4);
  if (words.length < 20) {
    return 0;
  }

  const damaged = words.filter((word) => /[a-zà-ÿ]\d[a-zà-ÿ]/i.test(word)).length;
  return damaged / words.length;
}

/**
 * Distance d'édition, plafonnée : dès que le seuil est dépassé, on abandonne
 * sans finir le calcul. C'est ce qui rend la recherche floue abordable sur
 * plusieurs milliers de caractères.
 */
function editDistance(a: string, b: string, limit: number): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      best = Math.min(best, current[j]);
    }

    if (best > limit) {
      return limit + 1;
    }
    previous = current;
  }

  return previous[b.length];
}

/**
 * La phrase figure-t-elle dans le texte, à quelques caractères près ?
 *
 * Une photo de police passée à la reconnaissance de caractères revient avec
 * des mots abîmés — sur un scan réel, tous les « c » étaient devenus des
 * « 8 » : « Modifi8ation d'assuran8e ». Les motifs exacts n'y résistent pas,
 * alors que la phrase reste évidente pour un lecteur. La tolérance est donc
 * appliquée en dernier recours, après l'échec des motifs exacts.
 */
function containsFuzzy(haystack: string, phrase: string, tolerance: number): boolean {
  const window = phrase.length;
  if (haystack.length < window) {
    return false;
  }

  // Un pas de deux caractères suffit : le décalage résiduel est absorbé par la
  // tolérance, et le coût du balayage est divisé par deux.
  for (let i = 0; i + window <= haystack.length; i += 2) {
    const slice = haystack.slice(i, i + window + tolerance);
    if (editDistance(phrase, slice.slice(0, window), tolerance) <= tolerance) {
      return true;
    }
  }
  return false;
}

/**
 * Couverture accident lue directement dans le texte.
 *
 * Les caisses l'écrivent en clair et de façon stéréotypée — « risque accidents
 * pas assuré », « avec accident », « ohne Unfalldeckung » — parce que la ligne
 * porte un rabais chiffré. Une règle explicite y est plus sûre qu'une
 * inférence, et le sujet le mérite : se tromper de sens change la prime de
 * plusieurs pour cent, dans un silence complet.
 *
 * Renvoie `true` si l'accident est **inclus** dans la LAMal.
 */
function accidentIncludedInText(excerpt: string): boolean | undefined {
  const text = excerpt.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  const excluded = /risque[s]? accident[s]?\s*(:|-)?\s*(pas|non)\s*assure|sans (couverture )?accident|accident[s]?\s*(:|-)?\s*(exclu|non assure|suspendu)|ohne unfall|unfalldeckung\s*(:|-)?\s*(nein|ausgeschlossen)|couvert[e]? par l.employeur/;
  const included = /risque[s]? accident[s]?\s*(:|-)?\s*(assure|inclus|couvert)|avec (couverture )?accident|accident[s]?\s*(:|-)?\s*(inclus|assure|couvert)|mit unfall|unfalldeckung\s*(:|-)?\s*(ja|eingeschlossen)/;

  // L'exclusion est testée d'abord : « accidents pas assuré » contient
  // « accidents » suivi d'un mot d'inclusion plus loin dans la phrase.
  if (excluded.test(text)) {
    return false;
  }
  if (included.test(text)) {
    return true;
  }

  // Rien de net : le texte est peut-être abîmé. Sur une photo, la
  // reconnaissance rend « Risque a88idents pas assuré » — les motifs exacts
  // ne mordent plus, alors que la phrase reste parfaitement reconnaissable à
  // deux caractères près.
  const damaged = /(pas|non)\s*assure|ohne\s*unfall|sans\s*accident/;
  if (containsFuzzy(text, 'risque accidents', 3) && damaged.test(text)) {
    return false;
  }
  if (containsFuzzy(text, 'accidents pas assure', 4) ||
      containsFuzzy(text, 'sans couverture accident', 4)) {
    return false;
  }
  if (containsFuzzy(text, 'risque accidents assure', 4) ||
      containsFuzzy(text, 'accident inclus', 3)) {
    return true;
  }
  return undefined;
}

/**
 * Départage plusieurs modèles d'une même famille par le montant de la prime.
 *
 * Sanitas propose quatre variantes « médecin de famille » et la police n'en
 * nomme aucune — mais elle porte un montant, et ce montant ne correspond qu'à
 * une seule d'entre elles dans le tarif officiel. La question n'est donc pas
 * insoluble : elle se résout par le calcul, sans rien deviner.
 *
 * Ne conclut que si **une seule** variante tombe juste au centime. Deux
 * variantes au même prix laissent l'ambiguïté entière, et c'est très bien
 * ainsi : à prime égale, le choix reste sans conséquence sur l'économie.
 */
async function disambiguateByPremium(
  candidates: CatalogueTariff[],
  catalogue: Catalogue,
  options: { age: number; franchise: number; withAccident: boolean; premium: number },
  insurerId: number
): Promise<CatalogueTariff[]> {
  // Les deux écritures de la prime sont interrogées d'un coup : le tarif de
  // l'OFSP est brut, les caisses impriment souvent le solde après déduction de
  // la redistribution des taxes environnementales. Sur la police d'exemple,
  // 334.05 et 328.90 désignent le même contrat.
  const premiums = await premiumsByTariff({
    year: catalogue.year,
    canton: catalogue.location.canton,
    region: catalogue.location.region,
    insurerId,
    age: options.age,
    franchise: options.franchise,
    withAccident: options.withAccident
  }, candidates.map((t) => t.tariffCode));

  return candidates.filter((tariff) => {
    const variants = premiums.get(tariff.tariffCode);
    if (!variants) {
      return false;
    }
    return Math.abs(variants.gross - options.premium) < 0.005 ||
      Math.abs(variants.net - options.premium) < 0.005;
  });
}

/**
 * Message d'ambiguïté, quand la famille est claire mais la variante non.
 *
 * Sanitas propose quatre modèles « médecin de famille » aux primes distinctes :
 * en choisir un au hasard reviendrait à annoncer une économie fausse. Autant
 * dire lesquels et laisser trancher.
 */
function familyAmbiguity(insurer: CatalogueInsurer, excerpt: string): string | undefined {
  const family = familyInText(excerpt);
  if (!family) {
    return undefined;
  }

  const candidates = insurer.tariffs.filter((t) => t.tariffType === family);
  if (candidates.length < 2) {
    return undefined;
  }

  const labels = candidates.map((t) => t.label).join(', ');
  const kind = family === 'HAM' ? 'médecin de famille'
    : family === 'HMO' ? 'HMO' : 'télémédecine';

  return `Votre police est un modèle « ${kind} », mais ${insurer.name} en propose ` +
    `plusieurs dans votre région (${labels}) et le document ne dit pas lequel. ` +
    'Choisissez le vôtre : la prime en dépend.';
}

// --------------------------------------------------------------- validation

function validateMain(
  raw: RawMain,
  catalogue: Catalogue,
  reading: PolicyReading,
  excerpt: string
): CatalogueInsurer | undefined {
  let insurer: CatalogueInsurer | undefined;

  const proposed = toText(raw.insurerName, 80);
  if (proposed) {
    insurer = resolveInsurer(proposed, catalogue, excerpt);
    if (insurer) {
      reading.insurerId = insurer.insurerId;
      reading.insurerName = insurer.name;
      reading.recognised.push('caisse');
    } else {
      reading.warnings.push(
        `La caisse « ${proposed} » n'a pas pu être retrouvée parmi celles proposées à ` +
        `${catalogue.location.label} : choisissez-la vous-même.`
      );
    }
  }

  const franchise = toNumber(raw.franchise);
  if (franchise !== undefined) {
    if (LEGAL_FRANCHISES.has(franchise)) {
      reading.franchise = franchise;
      reading.recognised.push('franchise');
    } else {
      reading.warnings.push(
        `La franchise lue (${franchise}) n'est pas une franchise légale : à choisir vous-même.`
      );
    }
  }

  const premium = toNumber(raw.premiumAmount);
  if (premium !== undefined) {
    if (premium >= MIN_PREMIUM && premium <= MAX_PREMIUM) {
      reading.premiumAmount = Math.round(premium * 100) / 100;
      reading.recognised.push('prime');
    } else {
      reading.warnings.push(
        `La prime lue (${premium} CHF) est invraisemblable pour une prime mensuelle : ignorée.`
      );
    }
  }

  const policyNumber = toText(raw.policyNumber, 40);
  if (policyNumber) {
    reading.policyNumber = policyNumber;
    reading.recognised.push('n° de police');
  }

  // Numéro AVS : format strict, il sert à retrouver l'assuré du foyer.
  const avs = toText(raw.avsNum, 20);
  if (avs) {
    const digits = avs.replace(/\D/g, '');
    if (/^756\d{10}$/.test(digits)) {
      reading.avsNum = `756.${digits.slice(3, 7)}.${digits.slice(7, 11)}.${digits.slice(11)}`;
      reading.recognised.push('n° AVS');
    } else {
      reading.warnings.push(`Le numéro AVS lu (${avs}) n'a pas le format attendu : ignoré.`);
    }
  }

  // Le formulaire raisonne à l'envers du document : il coche « couvert par
  // l'employeur », alors que la police dit si l'accident est inclus. On pose au
  // modèle la question dans le sens du document — la double négation est le
  // genre de subtilité sur laquelle un petit modèle se trompe — et l'inversion
  // est faite ici, une fois pour toutes.
  // Date de début : bornée au raisonnable. Un contrat LAMal ne commence pas
  // avant l'existence de la loi, ni plus d'un an après la période en cours —
  // une date fantaisiste décalerait toute l'échéance de résiliation.
  const start = toText(raw.startDate, 20);
  if (start) {
    const parsed = parseDate(start);
    if (parsed) {
      reading.startDate = parsed;
      reading.recognised.push('date de début');
    } else {
      reading.warnings.push(
        `La date de début lue (${start}) n'est pas exploitable : indiquez-la vous-même.`
      );
    }
  }

  // Le nom de l'assuré : beaucoup de polices ne portent aucun numéro AVS, et
  // c'est alors le seul moyen de rattacher le contrat à la bonne personne du
  // foyer sans le demander.
  const insuredName = toText(raw.insuredName, 120);
  if (insuredName) {
    reading.insuredName = insuredName;
  }
  const insuredBirthdate = toText(raw.insuredBirthdate, 20);
  if (insuredBirthdate) {
    reading.insuredBirthdate = parseBirthdate(insuredBirthdate);
  }

  const notes = toText(raw.notes, 500);
  if (notes) {
    reading.notes = notes;
    reading.recognised.push('précisions');
  }

  // La lecture directe du texte fait autorité ; le modèle ne sert que de
  // secours, quand la police l'exprime autrement que par les tournures usuelles.
  const accident = accidentIncludedInText(excerpt) ??
    (typeof raw.accidentIncluded === 'boolean' ? raw.accidentIncluded : undefined);
  if (accident !== undefined) {
    reading.employerAccidentCoverage = !accident;
    reading.recognised.push('couverture accident');
  }

  return insurer;
}

/**
 * Lit une police à partir du texte reconnu.
 *
 * Renvoie `null` quand le modèle est indisponible : l'appelant retombe alors
 * sur l'extraction par motifs. Une panne d'inférence ne doit jamais empêcher
 * d'enregistrer un contrat à la main.
 */
/**
 * Tente le départage par la prime, et renseigne la lecture s'il aboutit.
 * Nécessite l'âge de l'assuré : sans lui, aucun tarif ne peut être calculé.
 */
async function resolveByPremium(
  insurer: CatalogueInsurer,
  catalogue: Catalogue,
  excerpt: string,
  reading: PolicyReading,
  age?: number
): Promise<boolean> {
  if (age === undefined ||
      reading.franchise === undefined || reading.premiumAmount === undefined) {
    return false;
  }

  // Tous les modèles de la caisse sont éprouvés, pas seulement ceux de la
  // famille nommée : le montant est un identifiant bien plus sûr qu'un
  // intitulé commercial, surtout quand la reconnaissance de texte l'a abîmé.
  const matches = await disambiguateByPremium(insurer.tariffs, catalogue, {
    age,
    franchise: reading.franchise,
    // coverage=1 signifie que la LAMal inclut l'accident.
    withAccident: reading.employerAccidentCoverage !== true,
    premium: reading.premiumAmount
  }, insurer.insurerId);

  if (!matches.length) {
    return false;
  }

  // Une seule correspondance : c'est établi, sans rien deviner.
  if (matches.length === 1) {
    reading.tariffCode = matches[0].tariffCode;
    reading.tariffLabel = matches[0].label;
    reading.recognised.push('modèle');
    return true;
  }

  // Plusieurs modèles au même prix : la famille nommée sur le document, si
  // elle l'est, suffit alors à trancher. Sinon on renonce — mais à prime
  // égale, le choix reste sans conséquence sur l'économie annoncée.
  const family = familyInText(excerpt);
  const narrowed = family ? matches.filter((t) => t.tariffType === family) : [];
  if (narrowed.length === 1) {
    reading.tariffCode = narrowed[0].tariffCode;
    reading.tariffLabel = narrowed[0].label;
    reading.recognised.push('modèle');
    return true;
  }

  reading.warnings.push(
    `${matches.length} modèles de ${insurer.name} coûtent exactement ce prix ` +
    `(${matches.map((t) => t.label).join(', ')}) : choisissez le vôtre. ` +
    'À ce tarif, le choix ne change rien à votre prime.'
  );
  return false;
}

export async function readPolicy(
  text: string,
  catalogue: Catalogue,
  /** Âge de l'assuré, s'il est connu : sert à départager des modèles par leur prime. */
  age?: number
): Promise<PolicyReading | null> {
  const { enabled } = config();
  if (!enabled || text.trim().length < 40) {
    return null;
  }

  const excerpt = lamalExcerpt(text);
  const reading: PolicyReading = { warnings: [], recognised: [] };

  const damage = ocrDamage(excerpt);
  if (damage > 0.04) {
    reading.warnings.push(
      'Le texte reconnu sur cette image est abîmé : des lettres ont été prises pour ' +
      'des chiffres. Les montants restent fiables, mais les libellés le sont moins. ' +
      'Si vous avez la police en PDF, déposez-la : son texte est lu exactement, sans ' +
      'reconnaissance optique.'
    );
  }

  try {
    const main = await ask<RawMain>(mainPrompt(excerpt, catalogue), 400);
    if (!main.value) {
      return null;
    }
    if (main.truncated) {
      reading.warnings.push(
        'Le document est trop long pour être lu d\'un seul tenant : vérifiez ' +
        'particulièrement la caisse, le modèle et la prime.'
      );
    }

    const insurer = validateMain(main.value, catalogue, reading, excerpt);

    // Le montant d'abord.
    //
    // Le prix est un identifiant : pour une caisse, une région, un âge, une
    // franchise et une couverture accident donnés, chaque modèle a le sien.
    // Le rapprocher de celui imprimé sur la police tranche par le calcul, là
    // où l'intitulé commercial demande d'interpréter — et il résiste au bruit
    // de la reconnaissance de texte, qui abîme les mots mais rarement les
    // chiffres. Quand il aboutit, la seconde question au modèle est inutile.
    if (insurer && await resolveByPremium(insurer, catalogue, excerpt, reading, age)) {
      // Modèle établi par le montant : rien à demander de plus.
    } else if (insurer) {
      const answer = await ask<RawTariff>(tariffPrompt(excerpt, insurer), 60);
      const code = toText(answer.value?.tariffCode, 60);

      const tariff = code
        ? insurer.tariffs.find(
            (t) => tariffKey(t.tariffCode) === tariffKey(code) ||
              tariffKey(t.label) === tariffKey(code)
          )
        : undefined;

      if (tariff && tariffIsSupported(tariff, insurer, excerpt)) {
        reading.tariffCode = tariff.tariffCode;
        reading.tariffLabel = tariff.label;
        reading.recognised.push('modèle');
      } else if (reading.warnings.some((w) => w.includes('coûtent exactement ce prix'))) {
        // Le montant a déjà expliqué pourquoi il ne tranche pas : ne pas
        // superposer un second message sur le même sujet.
      } else {
        const ambiguity = familyAmbiguity(insurer, excerpt);
        if (ambiguity) {
          reading.warnings.push(ambiguity);
        } else if (tariff) {
          reading.warnings.push(
            `Le modèle « ${tariff.label} » a été proposé, mais rien de tel ne figure sur ` +
            'le document : choisissez votre modèle vous-même, il détermine votre prime.'
          );
        } else if (code) {
          reading.warnings.push(
            `Le modèle « ${code} » n'est pas proposé par ${insurer.name} dans votre ` +
            'région : choisissez-le vous-même.'
          );
        } else {
          reading.warnings.push(
            'Le modèle d\'assurance n\'a pas pu être déterminé : choisissez-le vous-même, ' +
            'il détermine votre prime.'
          );
        }
      }
    }

    return reading;
  } catch (err) {
    console.error('[police] lecture par modèle de langage impossible:', (err as Error).message);
    return null;
  }
}
