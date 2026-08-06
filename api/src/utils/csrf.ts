import { randomBytes, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * Protection CSRF par jeton de session (synchronizer token pattern).
 * Les formulaires de la console sont en same-origin et le cookie est en
 * SameSite=lax, mais les POST cross-site restent possibles : chaque mutation
 * doit porter le jeton.
 */
export function csrfToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export const CSRF_REJECTION_MESSAGE =
  'Jeton de sécurité invalide ou expiré. Rechargez la page et réessayez.';

/**
 * Contrôle pur, sans effet sur la réponse. Utile quand le corps de la requête
 * n'est analysé que plus tard dans la chaîne — un envoi multipart, par exemple.
 */
export function isCsrfValid(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return true;
  }

  const submitted = String(req.body?._csrf || '');
  const expected = req.session.csrfToken;

  return Boolean(expected && submitted && safeEqual(submitted, expected));
}

export function verifyCsrf(req: Request, res: Response, next: NextFunction) {
  if (!isCsrfValid(req)) {
    return res.status(403).type('text/plain').send(CSRF_REJECTION_MESSAGE);
  }
  next();
}
