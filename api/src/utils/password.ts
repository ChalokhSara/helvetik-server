import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

const KEY_LENGTH = 64;

export function generateSalt(): string {
  return randomBytes(16).toString('hex');
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return derived.toString('hex');
}

/**
 * Comparaison à temps constant pour éviter les timing attacks.
 */
export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string
): Promise<boolean> {
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(expectedHash, 'hex');

  if (expected.length !== derived.length) {
    return false;
  }

  return timingSafeEqual(derived, expected);
}
