import { Schema, model, Document } from 'mongoose';
import { randomUUID } from 'crypto';

/**
 * Journal des courriers confiés à ePost (md_letter_dispatch).
 *
 * Une résiliation LAMal se joue sur une date de réception : savoir ce qui est
 * parti, quand, et sous quelle référence n'est pas un confort d'exploitation
 * mais la seule preuve dont dispose l'assuré si la caisse conteste. Le PDF
 * n'est pas conservé — il se reconstruit à l'identique — mais la trace de
 * l'envoi, elle, doit survivre.
 *
 * Les aperçus y figurent aussi, marqués comme tels : ils disent le prix et les
 * canaux sans que rien ne parte, et l'on doit pouvoir distinguer d'un coup
 * d'œil une lettre réellement postée d'un essai.
 */

export type DispatchMode = 'PREVIEW' | 'LIVE';
export type DispatchLetterKind = 'CANCELLATION' | 'ENROLMENT';

export interface ILetterDispatch extends Document {
  uid: string;
  userUid: string;
  clientUid: string;
  kind: DispatchLetterKind;
  /** Année d'effet du changement, pour distinguer deux campagnes. */
  effectiveYear: number;
  mode: DispatchMode;
  /** Caisse destinataire, telle qu'imprimée sur l'enveloppe. */
  recipientName: string;
  /** Identifiant ePost, absent en mode aperçu. */
  deliveryId?: string;
  /** Référence Helvetik reprise dans le suivi ePost. */
  reference: string;
  status?: string;
  /** Prix annoncé par ePost, en francs. */
  price?: number;
  channels: string[];
  /** Message d'erreur renvoyé par ePost, le cas échéant. */
  error?: string;
  sentAt: Date;
  /** Dernier état relu auprès d'ePost. */
  checkedAt?: Date;
}

const letterDispatchSchema = new Schema<ILetterDispatch>({
  uid: {
    type: String,
    required: true,
    unique: true,
    default: () => randomUUID()
  },
  userUid: { type: String, required: true, index: true },
  clientUid: { type: String, required: true, index: true },
  kind: { type: String, required: true, enum: ['CANCELLATION', 'ENROLMENT'] },
  effectiveYear: { type: Number, required: true },
  mode: { type: String, required: true, enum: ['PREVIEW', 'LIVE'] },
  recipientName: { type: String, required: true },
  deliveryId: { type: String },
  reference: { type: String, required: true },
  status: { type: String },
  price: { type: Number },
  channels: { type: [String], default: [] },
  error: { type: String },
  sentAt: { type: Date, required: true, default: () => new Date() },
  checkedAt: { type: Date }
}, {
  collection: 'md_letter_dispatch'
});

// La page du changement lit l'historique d'un assuré, le plus récent d'abord.
letterDispatchSchema.index({ clientUid: 1, sentAt: -1 });

export const LetterDispatch = model<ILetterDispatch>(
  'LetterDispatch',
  letterDispatchSchema
);
