import cron from 'node-cron';
import { runNotificationSweep } from '../services/notification.service';
import { syncPremiumsFromOfsp } from '../services/premium-download.service';

/**
 * Planificateur des tâches de fond.
 *
 * `node-cron` tourne dans le processus de l'API, ce qui suffit tant qu'une
 * seule instance tourne. Avec plusieurs instances, chacune déclencherait sa
 * propre passe : les doublons d'emails sont déjà empêchés par la clé d'unicité
 * des notifications et la réservation atomique avant envoi, mais il faudra
 * un verrou en base pour éviter le travail redondant.
 */

// Tous les jours à 08h00, heure suisse.
const DEFAULT_SCHEDULE = '0 8 * * *';

/**
 * Vérification mensuelle des données de primes, le 1er à 04h00.
 *
 * Un rythme mensuel plutôt qu'annuel : l'OFSP publie les primes de l'année
 * suivante fin septembre, mais corrige parfois ses fichiers ensuite. La
 * comparaison d'empreinte fait qu'un passage sans nouveauté ne coûte que trois
 * téléchargements, sans aucune écriture en base.
 */
const DEFAULT_PREMIUM_SCHEDULE = '0 4 1 * *';

const TIMEZONE = process.env.TZ || 'Europe/Zurich';

export function startScheduler(): void {
  if (process.env.NOTIFICATIONS_ENABLED === 'false') {
    console.log('[scheduler] notifications désactivées (NOTIFICATIONS_ENABLED=false).');
    return;
  }

  const schedule = process.env.NOTIFICATIONS_CRON || DEFAULT_SCHEDULE;

  if (!cron.validate(schedule)) {
    console.error(`[scheduler] expression cron invalide : "${schedule}". Planification annulée.`);
    return;
  }

  cron.schedule(schedule, () => {
    runNotificationSweep().catch((err) =>
      console.error('[scheduler] échec du contrôle des échéances:', err)
    );
  }, { timezone: TIMEZONE });

  console.log(`[scheduler] contrôle des échéances planifié (${schedule}, ${TIMEZONE}).`);

  // Utile en développement pour voir le résultat sans attendre l'heure dite.
  if (process.env.NOTIFICATIONS_RUN_ON_START === 'true') {
    runNotificationSweep().catch((err) =>
      console.error('[scheduler] échec du contrôle initial:', err)
    );
  }

  startPremiumSync();
}

/**
 * Récupération automatique des fichiers de primes de l'OFSP.
 *
 * L'import est déposé en état « préparée » : la mise en service reste un geste
 * d'administrateur. Basculer automatiquement des tarifs sur lesquels reposent
 * les conseils donnés aux clients ne doit pas se faire sans relecture humaine.
 */
function startPremiumSync(): void {
  if (process.env.PREMIUM_SYNC_ENABLED === 'false') {
    console.log('[scheduler] synchronisation des primes désactivée.');
    return;
  }

  const schedule = process.env.PREMIUM_SYNC_CRON || DEFAULT_PREMIUM_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.error(`[scheduler] expression cron invalide pour les primes : "${schedule}".`);
    return;
  }

  cron.schedule(schedule, () => {
    syncPremiumsFromOfsp({ importedBy: 'planificateur' })
      .then((outcome) => {
        for (const result of outcome.results) {
          console.log(`[primes] ${result.message}`);
        }
        for (const skipped of outcome.skipped) {
          console.log(`[primes] ${skipped}`);
        }
        if (outcome.results.length) {
          console.log(
            '[primes] nouvelles données importées en état « préparée » : ' +
            'à vérifier puis mettre en service depuis /admin/premiums.'
          );
        }
      })
      .catch((err) => console.error('[scheduler] échec de la synchronisation des primes:', err));
  }, { timezone: TIMEZONE });

  console.log(`[scheduler] synchronisation des primes planifiée (${schedule}, ${TIMEZONE}).`);
}
