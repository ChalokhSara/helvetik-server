import { Schema, model, Document } from 'mongoose';
import { randomUUID } from 'crypto';

/**
 * Réponses au questionnaire de la phase de test.
 *
 * Le service ne souscrit aucune assurance pour l'instant : la page de
 * souscription explique cette limite et recueille à la place l'intérêt des
 * assurés, leur consentement à être recontactés et leur avis sur l'interface.
 * Ces réponses sont conservées telles quelles, sans traitement automatique.
 */

/** Intérêt déclaré pour le service, une fois celui-ci réellement disponible. */
export const INTEREST_LEVELS = ['OUI', 'PEUT_ETRE', 'NON'] as const;
export type InterestLevel = typeof INTEREST_LEVELS[number];

export const INTEREST_LABELS: Record<InterestLevel, string> = {
  OUI: 'Oui, ce service m\'intéresse',
  PEUT_ETRE: 'Peut-être, selon les conditions',
  NON: 'Non, ce service ne m\'intéresse pas'
};

export interface IFeedback extends Document {
  uid: string;
  userUid: string;
  /** Adresse du compte au moment de la réponse : le contact peut changer ensuite. */
  email: string;
  interest: InterestLevel;
  /** Prix jugé acceptable, en texte libre : « 50 CHF par an », « une commission »… */
  priceExpectation?: string;
  /** Souhaite figurer parmi les bêta-testeurs de l'année. */
  betaTester: boolean;
  /** Accepte d'être recontacté pour le changement de caisse de cette année. */
  recontact: boolean;
  /** Renseigné seulement si l'assuré a accepté d'être recontacté. */
  contactPhone?: string;
  /** Note d'ensemble de l'expérience, de 1 à 5. */
  experienceRating?: number;
  experienceComment?: string;
  improvements?: string;
  /**
   * Économie affichée au moment de la réponse. Sans elle, un avis sur le
   * service ne se relit pas : « intéressé » n'a pas le même sens selon qu'on
   * ait vu 5 ou 200 francs d'économie.
   */
  shownSavingsMonthly?: number;
  shownStrategy?: string;
  createdAt: Date;
}

const feedbackSchema = new Schema<IFeedback>({
  uid: { type: String, default: () => randomUUID(), unique: true, index: true },
  userUid: { type: String, required: true, index: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  interest: { type: String, enum: INTEREST_LEVELS, required: true },
  priceExpectation: { type: String, trim: true, maxlength: 200 },
  betaTester: { type: Boolean, default: false },
  recontact: { type: Boolean, default: false },
  contactPhone: { type: String, trim: true, maxlength: 40 },
  experienceRating: { type: Number, min: 1, max: 5 },
  experienceComment: { type: String, trim: true, maxlength: 4000 },
  improvements: { type: String, trim: true, maxlength: 4000 },
  shownSavingsMonthly: { type: Number },
  shownStrategy: { type: String, trim: true, maxlength: 40 },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'md_feedback' });

export const Feedback = model<IFeedback>('Feedback', feedbackSchema);
