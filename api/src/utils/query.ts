/**
 * Helpers de listing pour la console d'administration.
 */

export const PAGE_SIZE = 25;

/** Neutralise les métacaractères d'une saisie utilisateur utilisée en $regex. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parsePage(raw: unknown): number {
  const page = Number.parseInt(String(raw ?? '1'), 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

/**
 * Base d'URL pour la pagination : conserve les filtres courants et laisse
 * la place au paramètre `page`.
 */
export function buildBaseUrl(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      query.set(key, value);
    }
  }
  const prefix = query.toString();
  return prefix ? `${path}?${prefix}&` : `${path}?`;
}
