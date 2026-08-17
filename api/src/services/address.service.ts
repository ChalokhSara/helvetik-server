import { PremiumRegion } from '../models/premium.model';
import { activeYear } from './premium-import.service';

/**
 * Autocomplétion d'adresses suisses.
 *
 * Source : le service de recherche de swisstopo (api3.geo.admin.ch), officiel,
 * gratuit et sans clé, adossé au Registre fédéral des bâtiments et logements.
 *
 * `swiss-address-js` a été écarté : sa voie « open data » interroge un portail
 * de La Poste qui n'existe plus (404), et sa voie complète exige un compte
 * Address Web Services payant.
 *
 * Le canton n'est pas renvoyé par swisstopo : il est déduit du NPA grâce aux
 * régions de primes déjà importées, ce qui évite une seconde source à tenir.
 */

const SEARCH_URL = 'https://api3.geo.admin.ch/rest/services/api/SearchServer';
const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 1000 * 60 * 30;
const CACHE_MAX = 500;

export interface AddressSuggestion {
  /** Libellé complet, tel qu'affiché dans la liste. */
  label: string;
  road: string;
  plz: string;
  location: string;
  canton?: string;
}

const cache = new Map<string, { at: number; value: AddressSuggestion[] }>();

function readCache(key: string): AddressSuggestion[] | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache(key: string, value: AddressSuggestion[]): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

/**
 * « Avenue de France 1 1870 Monthey » → ses composants.
 * Le NPA à quatre chiffres sert de charnière : ce qui précède est la rue avec
 * son numéro, ce qui suit la localité.
 */
function splitLabel(label: string): { road: string; plz: string; location: string } | null {
  const clean = label.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const match = clean.match(/^(.*?)\s+(\d{4})\s+(.+)$/);
  if (!match) {
    return null;
  }
  return { road: match[1].trim(), plz: match[2], location: match[3].trim() };
}

/** Canton d'un NPA, d'après les régions de primes importées. */
async function cantonFor(plz: string, locality: string): Promise<string | undefined> {
  const year = await activeYear();
  if (!year) {
    return undefined;
  }
  const candidates = await PremiumRegion.find({ year: year.year, plz }).select('canton locality');
  if (!candidates.length) {
    return undefined;
  }
  const wanted = locality.toLowerCase();
  const exact = candidates.find((c) => c.locality.toLowerCase() === wanted);
  return (exact || candidates[0]).canton;
}

/**
 * Propositions d'adresses pour une saisie partielle.
 * Renvoie une liste vide plutôt qu'une erreur : l'autocomplétion est une aide,
 * son indisponibilité ne doit jamais empêcher une saisie manuelle.
 */
export async function suggestAddresses(query: string, limit = 8): Promise<AddressSuggestion[]> {
  const text = query.trim();
  if (text.length < 3) {
    return [];
  }

  const key = `${text.toLowerCase()}|${limit}`;
  const cached = readCache(key);
  if (cached) {
    return cached;
  }

  const url = `${SEARCH_URL}?type=locations&origins=address&limit=${limit}` +
    `&searchText=${encodeURIComponent(text)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = await response.json() as { results?: Array<{ attrs?: { label?: string } }> };
    const seen = new Set<string>();
    const suggestions: AddressSuggestion[] = [];

    for (const result of body.results || []) {
      const parts = splitLabel(String(result.attrs?.label || ''));
      if (!parts) continue;

      const label = `${parts.road}, ${parts.plz} ${parts.location}`;
      if (seen.has(label)) continue;
      seen.add(label);

      suggestions.push({
        label,
        ...parts,
        canton: await cantonFor(parts.plz, parts.location)
      });
    }

    writeCache(key, suggestions);
    return suggestions;
  } catch (err) {
    console.error('[adresses] recherche indisponible:', (err as Error).message);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Complète une adresse saisie à la main : retrouve le canton depuis le NPA.
 * Utile quand l'autocomplétion n'a pas été utilisée.
 */
export async function completeAddress(
  plz: string,
  location: string
): Promise<{ canton?: string; location?: string }> {
  const year = await activeYear();
  if (!year || !/^\d{4}$/.test(plz)) {
    return {};
  }

  const candidates = await PremiumRegion.find({ year: year.year, plz }).select('canton locality');
  if (!candidates.length) {
    return {};
  }

  const wanted = location.trim().toLowerCase();
  const exact = wanted
    ? candidates.find((c) => c.locality.toLowerCase() === wanted)
    : undefined;
  const chosen = exact || candidates[0];

  return { canton: chosen.canton, location: chosen.locality };
}
