import { createHash, randomBytes } from 'crypto';

/**
 * Jetons opaques (session mobile, confirmation d'email).
 *
 * Seule l'empreinte est stockée : une fuite de la base ne permet pas de
 * rejouer un jeton. Le hachage est un SHA-256 simple et non un KDF — c'est
 * suffisant ici, contrairement à un mot de passe le jeton est déjà une valeur
 * aléatoire de 256 bits, donc non devinable par force brute.
 */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
