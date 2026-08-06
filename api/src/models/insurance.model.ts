import { Schema, model, Document } from 'mongoose';
import { randomUUID } from 'crypto';

/**
 * Types d'assurance courants en Suisse, regroupés par famille :
 * personnes (santé, accident, prévoyance) puis biens et responsabilité.
 */
export const INSURANCE_TYPES = [
  'LAMAL',                  // assurance maladie de base (obligatoire)
  'COMPLEMENTAIRE_SANTE',   // LCA : complémentaires hospitalisation, dentaire, médecines douces
  'ACCIDENT',               // LAA, ou couverture accident hors employeur
  'INDEMNITE_JOURNALIERE',  // perte de gain maladie
  'VIE',                    // prévoyance, 3e pilier lié ou libre
  'RC_PRIVEE',              // responsabilité civile privée
  'MENAGE',                 // inventaire du ménage
  'BATIMENT',               // immeuble, propriétaire
  'VEHICULE',               // auto, moto, RC véhicule + casco
  'PROTECTION_JURIDIQUE',
  'VOYAGE',
  'ANIMAUX',
  'AUTRE'
] as const;

export type InsuranceType = typeof INSURANCE_TYPES[number];

/**
 * Statut administratif du contrat. Il est stocké et non déduit des dates :
 * un contrat peut être résilié avant son terme, ou signé à l'avance et pas
 * encore en vigueur. Le filtrage « en cours à telle date » se fait à part.
 */
export const INSURANCE_STATUSES = ['ACTIVE', 'PENDING', 'EXPIRED', 'CANCELLED'] as const;
export type InsuranceStatus = typeof INSURANCE_STATUSES[number];

/**
 * Familles de modèles LAMal, telles que les nomme l'OFSP : standard, médecin
 * de famille, HMO, et les autres formules (télémédecine, pharmacie…).
 */
export const TARIFF_TYPES = ['BASE', 'HAM', 'HMO', 'DIV'] as const;
export type TariffType = typeof TARIFF_TYPES[number];

export const TARIFF_TYPE_LABELS: Record<TariffType, string> = {
  BASE: 'Standard (libre choix du médecin)',
  HAM: 'Médecin de famille',
  HMO: 'HMO (cabinet de groupe)',
  DIV: 'Autre (télémédecine, pharmacie…)'
};

export const PREMIUM_FREQUENCIES = ['MENSUEL', 'TRIMESTRIEL', 'SEMESTRIEL', 'ANNUEL'] as const;
export type PremiumFrequency = typeof PREMIUM_FREQUENCIES[number];

/** Nombre de versements par an, pour ramener toutes les primes au mois. */
export const PAYMENTS_PER_YEAR: Record<PremiumFrequency, number> = {
  MENSUEL: 12,
  TRIMESTRIEL: 4,
  SEMESTRIEL: 2,
  ANNUEL: 1
};

export interface IInsurance extends Document {
  uid: string;
  /** Titulaire du compte. Dénormalisé depuis le client, pour interroger tout le foyer. */
  userUid: string;
  /** Personne assurée (md_client). */
  clientUid: string;
  provider: string;
  productName: string;
  type: InsuranceType;
  description?: string;
  policyNumber: string;
  startDate: Date;
  /** Fin de la période contractuelle en cours (cf. autoRenew pour la suite). */
  endDate: Date;
  status: InsuranceStatus;
  premiumAmount: number;
  premiumFrequency: PremiumFrequency;
  currency: string;
  franchise?: number;
  coverageAmount?: number;
  /** Préavis de résiliation, en mois. Sert à calculer la date limite. */
  cancellationNoticeMonths?: number;
  autoRenew: boolean;
  /**
   * LAMal uniquement : l'assuré est couvert contre les accidents par son
   * employeur (LAA), et sa LAMal exclut donc la couverture accident.
   */
  employerAccidentCoverage: boolean;
  /**
   * LAMal uniquement : modèle d'assurance, au sens de l'OFSP.
   * `tariffType` est la famille (standard, médecin de famille, HMO, autre) et
   * `tariffCode` l'offre précise du catalogue officiel. Sans eux, la
   * comparaison de primes doit supposer le modèle standard.
   */
  tariffType?: TariffType;
  tariffCode?: string;
  /** Identifiant OFSP de la caisse, quand il a pu être résolu. */
  insurerId?: number;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const insuranceSchema = new Schema<IInsurance>({
  uid: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => randomUUID()
  },
  userUid: {
    type: String,
    required: true,
    index: true
  },
  clientUid: {
    type: String,
    required: [true, 'L\'assuré est obligatoire.'],
    index: true
  },
  provider: {
    type: String,
    required: [true, 'Le prestataire est obligatoire.'],
    trim: true,
    index: true
  },
  productName: {
    type: String,
    required: [true, 'Le nom de l\'offre est obligatoire.'],
    trim: true
  },
  type: {
    type: String,
    required: [true, 'Le type d\'assurance est obligatoire.'],
    enum: { values: INSURANCE_TYPES, message: 'Type d\'assurance invalide.' },
    index: true
  },
  description: {
    type: String,
    trim: true
  },
  // Volontairement non unique : un contrat familial (ménage, RC) porte le même
  // numéro de police pour plusieurs assurés.
  policyNumber: {
    type: String,
    required: [true, 'Le numéro de police est obligatoire.'],
    trim: true,
    index: true
  },
  startDate: {
    type: Date,
    required: [true, 'La date de début est obligatoire.']
  },
  // Terme de la période en cours, et non fin définitive du contrat : sur un
  // contrat à reconduction tacite (autoRenew), c'est le 31.12 de l'année pour
  // une LAMal, la date anniversaire ailleurs. Obligatoire, car c'est d'elle que
  // dépendent l'échéance de résiliation et les rappels associés.
  endDate: {
    type: Date,
    required: [true, 'La date de fin est obligatoire.'],
    validate: {
      validator: function (this: IInsurance, value?: Date) {
        return !value || !this.startDate || value >= this.startDate;
      },
      message: 'La date de fin doit être postérieure à la date de début.'
    }
  },
  status: {
    type: String,
    required: true,
    enum: { values: INSURANCE_STATUSES, message: 'Statut invalide.' },
    default: 'ACTIVE',
    index: true
  },
  premiumAmount: {
    type: Number,
    required: [true, 'La prime est obligatoire.'],
    min: [0, 'La prime ne peut pas être négative.']
  },
  premiumFrequency: {
    type: String,
    required: true,
    enum: { values: PREMIUM_FREQUENCIES, message: 'Périodicité de prime invalide.' },
    default: 'MENSUEL'
  },
  currency: {
    type: String,
    required: true,
    default: 'CHF',
    uppercase: true,
    trim: true
  },
  // Franchise annuelle (LAMal : 300 à 2500 pour un adulte).
  franchise: {
    type: Number,
    min: [0, 'La franchise ne peut pas être négative.']
  },
  // Somme assurée (ménage, RC, bâtiment, vie).
  coverageAmount: {
    type: Number,
    min: [0, 'La somme assurée ne peut pas être négative.']
  },
  cancellationNoticeMonths: {
    type: Number,
    min: [0, 'Le préavis ne peut pas être négatif.'],
    max: [24, 'Le préavis ne peut pas dépasser 24 mois.']
  },
  autoRenew: {
    type: Boolean,
    required: true,
    default: true
  },
  // Pertinent pour les contrats LAMal seulement. Toute personne employée plus
  // de 8 h par semaine est assurée contre les accidents par son employeur et
  // fait retirer cette couverture de sa LAMal, ce qui réduit sa prime.
  // Défaut à false : couverture accident incluse, cas de l'assuré non salarié.
  employerAccidentCoverage: {
    type: Boolean,
    required: true,
    default: false
  },
  // Modèle LAMal. Laissé libre pour les autres types d'assurance, qui n'ont
  // pas de catalogue officiel équivalent.
  tariffType: {
    type: String,
    enum: { values: TARIFF_TYPES, message: 'Modèle d\'assurance invalide.' }
  },
  tariffCode: {
    type: String,
    trim: true
  },
  insurerId: {
    type: Number,
    min: [0, 'L\'identifiant de caisse ne peut pas être négatif.']
  },
  notes: {
    type: String,
    trim: true
  }
}, {
  collection: 'md_insurance',
  timestamps: true
});

// Listing du foyer filtré par type ou statut : le cas d'usage principal.
insuranceSchema.index({ userUid: 1, type: 1 });
insuranceSchema.index({ userUid: 1, status: 1 });

export const Insurance = model<IInsurance>('Insurance', insuranceSchema);
