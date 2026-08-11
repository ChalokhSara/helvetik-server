/**
 * Page de retour de confirmation d'email — ouverte dans un navigateur depuis
 * le lien reçu par email, donc rendue avec la mise en page du site des assurés
 * et non celle de la console d'administration.
 */

import { renderEmailConfirmation } from './site/pages';

export function renderEmailConfirmationPage(
  options: { success: boolean; message: string }
): string {
  return renderEmailConfirmation(options);
}
