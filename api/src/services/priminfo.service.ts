/**
 * Résolution des identifiants internes de priminfo.admin.ch, le comparateur
 * officiel de l'OFSP.
 *
 * Les paramètres `location_id` et `insurer` de ses URL ne sont ni le NPA ni le
 * nom de la caisse : ce sont des identifiants propres au site. Deux catalogues
 * publics permettent de les retrouver, tous deux mis en cache car ils changent
 * au plus une fois par an :
 *
 *   - localités : /fr/praemien/locations, qui renvoie `Locations = {index, names}`
 *   - assureurs : la liste <option> du formulaire de la page de comparaison
 *
 * Rien de tout cela n'est documenté ni contractuel. Toute la résolution est
 * donc « au mieux » : si un catalogue devient inaccessible ou change de forme,
 * le lien reste construit sans le paramètre concerné, et priminfo demandera
 * l'information à l'utilisateur.
 */

const BASE_URL = process.env.PRIMINFO_BASE_URL || 'https://www.priminfo.admin.ch';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 h
const FETCH_TIMEOUT_MS = 10_000;

export interface LocationMatch {
  id: string;
  label: string;
}

export interface InsurerMatch {
  id: string;
  name: string;
}

interface Cached<T> {
  value: T;
  loadedAt: number;
}

interface LocationCatalogue {
  /** NPA ou nom normalisé -> identifiants priminfo. */
  index: Record<string, string[]>;
  /** Identifiant -> libellé lisible, ex. « 1871 Choëx (Commune Monthey) ». */
  names: Record<string, string>;
}

let locationCache: Cached<LocationCatalogue> | undefined;
// Les caisses disponibles varient d'un canton à l'autre : le cache est donc
// indexé par localité, pas global.
const insurerCache = new Map<string, Cached<InsurerMatch[]>>();

/** Minuscules sans accents : les clés du catalogue conservent les accents. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    // Diacritiques combinants isolés par la décomposition NFD.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function isFresh(entry?: Cached<unknown>): boolean {
  return Boolean(entry && Date.now() - entry.loadedAt < CACHE_TTL_MS);
}

export async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Helvetik/1.0' }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function loadLocations(): Promise<LocationCatalogue | undefined> {
  if (isFresh(locationCache)) {
    return locationCache!.value;
  }

  try {
    // Le paramètre `query` est exigé mais ignoré : la réponse est le catalogue complet.
    const raw = await fetchText(`${BASE_URL}/fr/praemien/locations?query=a`);
    const json = raw.replace(/^\s*Locations\s*=\s*/, '').replace(/;\s*$/, '');
    const parsed = JSON.parse(json) as LocationCatalogue;

    if (!parsed?.index || !parsed?.names) {
      throw new Error('structure inattendue');
    }

    // Index normalisé maison : les clés d'origine gardent les accents
    // (« zürich » et non « zurich »), ce qui rend la recherche par nom fragile.
    const index: Record<string, string[]> = { ...parsed.index };
    for (const [id, label] of Object.entries(parsed.names)) {
      const locality = normalize(label.replace(/\s*\(.*\)\s*$/, '').replace(/^\d{4}\s*/, ''));
      if (locality) {
        (index[locality] ||= []).push(id);
      }
    }

    locationCache = { value: { index, names: parsed.names }, loadedAt: Date.now() };
    return locationCache.value;
  } catch (err) {
    console.error('[priminfo] catalogue des localités indisponible:', (err as Error).message);
    // Un catalogue périmé vaut mieux que rien.
    return locationCache?.value;
  }
}

/**
 * Caisses proposées pour une localité donnée. La liste n'est rendue qu'une fois
 * `location_id` fourni, et son contenu dépend du canton : la charger sans
 * localité renverrait un sélecteur vide.
 */
async function loadInsurers(locationId: string): Promise<InsurerMatch[] | undefined> {
  const cached = insurerCache.get(locationId);
  if (isFresh(cached)) {
    return cached!.value;
  }

  try {
    const html = await fetchText(
      `${BASE_URL}/fr/praemien?location_id=${encodeURIComponent(locationId)}`
    );
    // La liste est rendue côté serveur dans le <select name="insurer">. On s'y
    // limite : la page contient d'autres listes à valeurs numériques (franchises).
    const select = html.match(/<select[^>]*name="insurer"[\s\S]*?<\/select>/i)?.[0];
    if (!select) {
      throw new Error('sélecteur d\'assureurs introuvable');
    }

    const insurers: InsurerMatch[] = [];
    const option = /<option\s+value="(\d+)"[^>]*>([^<]+)<\/option>/gi;
    for (let m = option.exec(select); m; m = option.exec(select)) {
      insurers.push({ id: m[1], name: m[2].trim() });
    }

    if (!insurers.length) {
      throw new Error('aucun assureur extrait');
    }

    insurerCache.set(locationId, { value: insurers, loadedAt: Date.now() });
    return insurers;
  } catch (err) {
    console.error('[priminfo] catalogue des assureurs indisponible:', (err as Error).message);
    return cached?.value;
  }
}

/**
 * Retrouve la localité priminfo depuis un NPA, en levant l'ambiguïté avec le
 * nom de localité : le NPA 1008 couvre Jouxtens-Mézery et Prilly, qui ne sont
 * pas dans la même région de primes.
 */
export async function resolveLocation(
  plz: string,
  locality?: string
): Promise<{ match?: LocationMatch; warning?: string }> {
  const catalogue = await loadLocations();
  if (!catalogue) {
    return { warning: 'Catalogue des localités indisponible : la localité devra être saisie sur priminfo.' };
  }

  const candidates = catalogue.index[plz.trim()];
  if (!candidates?.length) {
    const byName = locality ? catalogue.index[normalize(locality)] : undefined;
    if (byName?.length) {
      const id = byName[0];
      return { match: { id, label: catalogue.names[id] } };
    }
    return { warning: `NPA ${plz} introuvable chez priminfo : la localité devra être saisie sur place.` };
  }

  if (candidates.length === 1) {
    const id = candidates[0];
    return { match: { id, label: catalogue.names[id] } };
  }

  const wanted = normalize(locality || '');
  const exact = wanted
    ? candidates.find((id) => normalize(catalogue.names[id] || '').includes(wanted))
    : undefined;

  if (exact) {
    return { match: { id: exact, label: catalogue.names[exact] } };
  }

  const fallback = candidates[0];
  return {
    match: { id: fallback, label: catalogue.names[fallback] },
    warning: `Le NPA ${plz} couvre plusieurs localités ; « ${catalogue.names[fallback]} » a été retenue. ` +
      'Vérifiez-la sur priminfo, la région de primes peut différer.'
  };
}

/**
 * Retrouve l'assureur priminfo depuis le nom du prestataire saisi par
 * l'utilisateur. Correspondance souple : « CSS » doit trouver « CSS Assurance ».
 */
export async function resolveInsurer(
  provider: string,
  locationId: string
): Promise<{ match?: InsurerMatch; warning?: string }> {
  const insurers = await loadInsurers(locationId);
  if (!insurers) {
    return { warning: 'Catalogue des assureurs indisponible : la caisse actuelle ne sera pas présélectionnée.' };
  }

  const wanted = normalize(provider);
  if (!wanted) {
    return {};
  }

  const exact = insurers.find((i) => normalize(i.name) === wanted);
  if (exact) {
    return { match: exact };
  }

  const partial = insurers.filter(
    (i) => normalize(i.name).includes(wanted) || wanted.includes(normalize(i.name))
  );
  if (partial.length === 1) {
    return { match: partial[0] };
  }
  if (partial.length > 1) {
    // Le plus court nom est le plus générique, donc le plus probable.
    const best = partial.sort((a, b) => a.name.length - b.name.length)[0];
    return {
      match: best,
      warning: `Plusieurs caisses correspondent à « ${provider} » ; « ${best.name} » a été retenue.`
    };
  }

  return {
    warning: `La caisse « ${provider} » n'a pas été reconnue parmi celles proposées dans cette localité.`
  };
}

/** Vide les caches — utile en test, ou après un changement d'année tarifaire. */
export function clearPriminfoCache(): void {
  locationCache = undefined;
  insurerCache.clear();
}
