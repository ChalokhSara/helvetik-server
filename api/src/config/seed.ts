import { Admin } from '../models/admin.model';
import { generateSalt, hashPassword } from '../utils/password';

const ROOT_USERNAME = 'root';
const ROOT_DEFAULT_PASSWORD = 'helvetik';
const ROOT_EMAIL = process.env.ROOT_ADMIN_EMAIL || 'root@helvetik.local';

/**
 * Crée le super admin au démarrage s'il n'existe pas encore.
 * Idempotent : un root déjà présent est laissé intact.
 *
 * Le mot de passe par défaut est jetable : mustChangePassword force le
 * changement dès la première connexion.
 */
export async function ensureSuperAdmin(): Promise<void> {
  const existing = await Admin.findOne({ username: ROOT_USERNAME });

  if (existing) {
    return;
  }

  const salt = generateSalt();
  const password = await hashPassword(ROOT_DEFAULT_PASSWORD, salt);

  await Admin.create({
    username: ROOT_USERNAME,
    email: ROOT_EMAIL,
    password,
    salt,
    mustChangePassword: true
  });

  console.log(
    `Super admin "${ROOT_USERNAME}" créé (mot de passe "${ROOT_DEFAULT_PASSWORD}", ` +
    'à changer obligatoirement à la première connexion).'
  );
}
