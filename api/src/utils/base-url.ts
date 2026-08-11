import { Request } from 'express';

/**
 * Adresse publique du service, telle qu'elle doit apparaître dans les emails.
 *
 * L'IP du conteneur (172.x.x.x) ne conviendrait pas : elle n'est joignable que
 * depuis le réseau Docker. Ce qui compte est l'adresse par laquelle
 * l'utilisateur a atteint le site — `localhost:3000` depuis le poste,
 * `192.168.1.127:3000` depuis un téléphone du réseau, `https://helvetik.ch`
 * en production. Elle se lit dans la requête.
 *
 * En production, l'en-tête `Host` est fourni par le client et donc
 * manipulable : un attaquant pourrait faire pointer un lien de confirmation
 * vers son propre domaine. `APP_BASE_URL` y fait donc autorité, et la requête
 * n'est utilisée qu'à défaut.
 */

const FALLBACK_PORT = process.env.PORT || 3000;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Retire le `/` final pour que les concaténations restent propres. */
function trim(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Hôtes autorisés à figurer dans un lien, hors `APP_BASE_URL`.
 * Utile derrière un proxy servant plusieurs noms.
 */
function allowedHosts(): string[] {
  return (process.env.APP_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function fromRequest(req: Request): string | undefined {
  // `trust proxy` fait qu'Express lit X-Forwarded-Proto et X-Forwarded-Host.
  const host = req.get('host');
  if (!host) {
    return undefined;
  }
  return trim(`${req.protocol}://${host}`);
}

/**
 * URL de base à utiliser dans un lien envoyé par email.
 * Sans requête — cas des rappels envoyés par le planificateur — seule la
 * configuration peut répondre.
 */
export function resolveBaseUrl(req?: Request): string {
  const configured = process.env.APP_BASE_URL ? trim(process.env.APP_BASE_URL) : undefined;

  if (isProduction()) {
    if (configured) {
      return configured;
    }
    // Sans configuration, on accepte l'hôte de la requête seulement s'il est
    // explicitement autorisé : c'est le dernier garde-fou contre un lien forgé.
    const fromReq = req ? fromRequest(req) : undefined;
    if (fromReq) {
      const host = new URL(fromReq).host.toLowerCase();
      if (allowedHosts().includes(host)) {
        return fromReq;
      }
    }
    // Ni configuration ni hôte autorisé : on renonce à l'hôte de la requête.
    // Un lien inutilisable se corrige ; un lien pointant vers le domaine d'un
    // attaquant lui livre les jetons de confirmation de vos utilisateurs.
    console.error(
      '[config] APP_BASE_URL n\'est pas défini en production et l\'hôte de la requête ' +
      `(${fromReq ?? 'inconnu'}) n\'est pas dans APP_ALLOWED_HOSTS : les liens des emails ` +
      'seront inutilisables. Définissez APP_BASE_URL.'
    );
    return `http://localhost:${FALLBACK_PORT}`;
  }

  // Hors production, l'adresse réellement utilisée par le visiteur prime :
  // c'est ce qui rend le lien cliquable depuis un téléphone du réseau local.
  return (req ? fromRequest(req) : undefined) || configured || `http://localhost:${FALLBACK_PORT}`;
}
