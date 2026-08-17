import { Insurance, IInsurance } from '../models/insurance.model';
import { Client } from '../models/client.model';
import { User } from '../models/user.model';
import {
  Notification,
  REMINDER_MILESTONES
} from '../models/notification.model';
import { cancellationDeadline } from '../utils/insurance-payload';
import { describeClient } from './household.service';
import { sendCancellationReminder } from '../utils/mailer';

/** Au-delà, on cesse de réessayer un envoi qui échoue systématiquement. */
const MAX_ATTEMPTS = 3;

/** Envois traités au maximum par passe, pour borner la durée d'un tour. */
const DELIVERY_BATCH = 500;

/**
 * Délai après lequel une notification restée « SENDING » est considérée comme
 * abandonnée — processus tué en plein envoi — et redevient éligible.
 */
const STUCK_AFTER_MS = 15 * 60 * 1000;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface SweepReport {
  scanned: number;
  created: number;
  sent: number;
  failed: number;
}

/** Nombre de jours entiers entre deux dates, en UTC comme les dates stockées. */
function daysBetween(from: Date, to: Date): number {
  const startOfDay = (d: Date) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((startOfDay(to) - startOfDay(from)) / MS_PER_DAY);
}

/**
 * Palier de rappel applicable aujourd'hui : le plus serré des paliers déjà
 * atteints.
 *
 * À 20 jours de l'échéance, les paliers 90 et 30 sont tous deux « atteints » ;
 * n'en retenir que le plus petit évite d'envoyer d'un coup tous les rappels
 * en retard à un contrat saisi tardivement. Les paliers suivants partiront
 * normalement, chacun une seule fois grâce à la clé d'unicité.
 */
function currentMilestone(daysLeft: number): number | undefined {
  const reached = REMINDER_MILESTONES.filter((m) => daysLeft <= m);
  return reached.length ? Math.min(...reached) : undefined;
}

function dedupKey(insurance: IInsurance, milestone: number, deadline: Date): string {
  // La date d'échéance fait partie de la clé : après reconduction, le terme
  // change et une nouvelle série de rappels peut repartir.
  return `${insurance.uid}:CANCELLATION_DEADLINE:${milestone}:${deadline.toISOString().slice(0, 10)}`;
}

/**
 * Repère les contrats dont l'échéance de résiliation approche et matérialise
 * les rappels correspondants. N'envoie rien : la livraison est un second temps.
 */
async function materializeReminders(now: Date): Promise<{ scanned: number; created: number }> {
  // Seuls les contrats en vigueur assortis d'un préavis ont une échéance.
  const insurances = await Insurance.find({
    status: 'ACTIVE',
    cancellationNoticeMonths: { $gt: 0 }
  });

  let created = 0;

  for (const insurance of insurances) {
    const deadline = cancellationDeadline(insurance);
    if (!deadline) {
      continue;
    }

    const daysLeft = daysBetween(now, deadline);
    // Échéance dépassée : plus rien à rappeler pour cette période.
    if (daysLeft < 0) {
      continue;
    }

    const milestone = currentMilestone(daysLeft);
    if (milestone === undefined) {
      continue;
    }

    const key = dedupKey(insurance, milestone, deadline);
    if (await Notification.exists({ dedupKey: key })) {
      continue;
    }

    const client = await Client.findOne({ uid: insurance.clientUid });
    const user = await User.findOne({ uid: insurance.userUid });
    if (!client || !user) {
      console.warn(`[notifications] contrat ${insurance.uid} orphelin, ignoré.`);
      continue;
    }
    // Un compte bloqué ne doit plus rien recevoir.
    if (user.blocked) {
      continue;
    }

    try {
      await Notification.create({
        userUid: insurance.userUid,
        clientUid: insurance.clientUid,
        insuranceUid: insurance.uid,
        type: 'CANCELLATION_DEADLINE',
        milestone,
        dedupKey: key,
        deadline,
        scheduledFor: now,
        snapshot: {
          email: user.email,
          insuredName: describeClient(client),
          provider: insurance.provider,
          productName: insurance.productName,
          policyNumber: insurance.policyNumber,
          endDate: insurance.endDate
        }
      });
      created++;
    } catch (err) {
      // 11000 = clé déjà prise : une autre instance a créé le rappel entre le
      // test d'existence et l'insertion. C'est exactement ce que l'index unique
      // doit empêcher, ce n'est pas une erreur.
      if ((err as { code?: number }).code !== 11000) {
        throw err;
      }
    }
  }

  return { scanned: insurances.length, created };
}

/**
 * Envoie les rappels en attente.
 *
 * Les candidats sont figés en début de passe : sans cela, une notification qui
 * échoue serait aussitôt reprise par la boucle et consommerait ses trois
 * tentatives d'affilée — le temps que le serveur mail revienne, le rappel
 * serait définitivement abandonné. Une tentative par passe étale les reprises
 * sur trois jours.
 *
 * Chaque envoi reste réservé par une mise à jour atomique : deux instances ne
 * peuvent pas expédier le même email.
 */
async function deliverPending(now: Date): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  const claimable = {
    attempts: { $lt: MAX_ATTEMPTS },
    $or: [
      { status: { $in: ['PENDING', 'FAILED'] } },
      // Reprise des envois interrompus par un arrêt brutal du processus.
      { status: 'SENDING', updatedAt: { $lt: new Date(Date.now() - STUCK_AFTER_MS) } }
    ]
  };

  const candidates = await Notification.find(claimable)
    .select('_id')
    .sort({ scheduledFor: 1 })
    .limit(DELIVERY_BATCH);

  for (const candidate of candidates) {
    const notification = await Notification.findOneAndUpdate(
      { _id: candidate._id, ...claimable },
      { $set: { status: 'SENDING' }, $inc: { attempts: 1 } },
      { new: true }
    );

    // Déjà pris par une autre instance entre la sélection et la réservation.
    if (!notification) {
      continue;
    }

    const snapshot = notification.snapshot;
    const ok = await sendCancellationReminder({
      to: snapshot.email,
      insuredName: snapshot.insuredName,
      provider: snapshot.provider,
      productName: snapshot.productName,
      policyNumber: snapshot.policyNumber,
      deadline: notification.deadline,
      endDate: snapshot.endDate,
      // Compté depuis l'heure de la passe : un rappel créé hier et expédié
      // aujourd'hui doit annoncer le délai réel du jour de l'envoi.
      daysLeft: daysBetween(now, notification.deadline)
    });

    if (ok) {
      notification.status = 'SENT';
      notification.sentAt = new Date();
      notification.lastError = undefined;
      sent++;
    } else {
      notification.status = 'FAILED';
      notification.lastError = notification.attempts >= MAX_ATTEMPTS
        ? `Envoi email en échec après ${MAX_ATTEMPTS} tentatives, abandonné.`
        : 'Envoi email en échec, nouvelle tentative à la prochaine passe.';
      failed++;
    }
    await notification.save();
  }

  return { sent, failed };
}

/**
 * Une passe complète : détection des échéances puis envoi.
 * Exportée pour pouvoir être déclenchée à la main comme par le planificateur.
 */
export async function runNotificationSweep(now = new Date()): Promise<SweepReport> {
  const { scanned, created } = await materializeReminders(now);
  const { sent, failed } = await deliverPending(now);

  const report = { scanned, created, sent, failed };
  if (created || sent || failed) {
    console.log(
      `[notifications] ${scanned} contrat(s) examiné(s), ${created} rappel(s) créé(s), ` +
      `${sent} envoyé(s), ${failed} en échec.`
    );
  }
  return report;
}
