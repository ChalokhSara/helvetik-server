/**
 * Page de retour de confirmation d'email — ouverte dans un navigateur depuis
 * le lien reçu par email, donc rendue en HTML plutôt qu'en JSON.
 */

import { alertBlock, cardPage } from './layout';

export function renderEmailConfirmationPage(
  options: { success: boolean; message: string }
): string {
  const body = options.success
    ? alertBlock(undefined, options.message)
    : alertBlock(options.message);

  return cardPage('Helvetik — Confirmation d\'email', `    <h1>Helvetik</h1>
    <p class="subtitle">Confirmation d'adresse email</p>
${body}`);
}
