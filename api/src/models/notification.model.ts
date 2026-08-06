import { Schema, model, Document } from 'mongoose';
import { randomUUID } from 'crypto';

/**
 * Notifications matérialisées : le job d'échéances écrit ici, les canaux de
 * livraison (email aujourd'hui, push demain) lisent ici.
 *
 * Sans cette trace, un job relancé le lendemain renotifierait tout le monde.
 */

export const NOTIFICATION_TYPES = ['CANCELLATION_DEADLINE'] as const;
export type NotificationType = typeof NOTIFICATION_TYPES[number];

export const NOTIFICATION_STATUSES = ['PENDING', 'SENDING', 'SENT', 'FAILED'] as const;
export type NotificationStatus = typeof NOTIFICATION_STATUSES[number];

/** Paliers de rappel, en jours avant l'échéance. */
export const REMINDER_MILESTONES = [90, 30, 7] as const;

export interface INotification extends Document {
  uid: string;
  userUid: string;
  clientUid: string;
  insuranceUid: string;
  type: NotificationType;
  /** Palier ayant déclenché ce rappel (90, 30 ou 7 jours). */
  milestone: number;
  /**
   * Clé d'unicité. Elle inclut la date d'échéance : après reconduction, le
   * terme change, la clé change, et une nouvelle série de rappels repart.
   */
  dedupKey: string;
  deadline: Date;
  scheduledFor: Date;
  status: NotificationStatus;
  attempts: number;
  sentAt?: Date;
  lastError?: string;
  /**
   * Instantané du contrat au moment du rappel. Recopié plutôt que joint, pour
   * que l'historique reste fidèle même si le contrat est modifié ou supprimé.
   */
  snapshot: {
    email: string;
    insuredName: string;
    provider: string;
    productName: string;
    policyNumber: string;
    endDate: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>({
  uid: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => randomUUID()
  },
  userUid: { type: String, required: true, index: true },
  clientUid: { type: String, required: true },
  insuranceUid: { type: String, required: true, index: true },
  type: {
    type: String,
    required: true,
    enum: NOTIFICATION_TYPES
  },
  milestone: { type: Number, required: true },
  // L'index unique est la garantie anti-doublon : deux exécutions simultanées
  // du job ne peuvent pas créer deux fois le même rappel.
  dedupKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  deadline: { type: Date, required: true },
  scheduledFor: { type: Date, required: true },
  status: {
    type: String,
    required: true,
    enum: NOTIFICATION_STATUSES,
    default: 'PENDING',
    index: true
  },
  attempts: { type: Number, required: true, default: 0 },
  sentAt: { type: Date },
  lastError: { type: String },
  snapshot: {
    email: { type: String, required: true },
    insuredName: { type: String, required: true },
    provider: { type: String, required: true },
    productName: { type: String, required: true },
    policyNumber: { type: String, required: true },
    endDate: { type: Date, required: true }
  }
}, {
  collection: 'md_notification',
  timestamps: true
});

export const Notification = model<INotification>('Notification', notificationSchema);
