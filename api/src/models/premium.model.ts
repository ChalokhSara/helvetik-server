import { Schema, model, Document } from 'mongoose';

/**
 * Données officielles des primes LAMal, importées depuis les fichiers publiés
 * chaque année par l'OFSP (priminfo.admin.ch / opendata.swiss).
 *
 * Trois sources, trois collections :
 *   - `gesamtbericht_ch.xlsx`     -> md_premium        (toutes les primes)
 *   - `praemienregionen.xlsx`     -> md_premium_region (NPA -> région de primes)
 *   - `assureurs-maladie-admis`   -> md_premium_insurer (identifiant -> nom)
 *
 * Une année d'import forme un tout cohérent : elle est constituée à l'état
 * `DRAFT`, vérifiée, puis activée. L'année précédente reste consultable.
 */

export const PREMIUM_YEAR_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type PremiumYearStatus = typeof PREMIUM_YEAR_STATUSES[number];

export const SOURCE_KINDS = ['PREMIUMS', 'REGIONS', 'INSURERS'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

/** Classes d'âge officielles : enfant, jeune adulte, adulte. */
export const AGE_CLASSES = ['KIN', 'JUG', 'ERW'] as const;
export type AgeClass = typeof AGE_CLASSES[number];

export const TARIFF_TYPES = ['BASE', 'HAM', 'HMO', 'DIV'] as const;
export type TariffType = typeof TARIFF_TYPES[number];

export interface PremiumSource {
  kind: SourceKind;
  filename: string;
  /** Empreinte du fichier : évite de réimporter deux fois le même. */
  sha256: string;
  size: number;
  rows: number;
  origin: 'UPLOAD' | 'DOWNLOAD';
  importedAt: Date;
  importedBy?: string;
}

export interface IPremiumYear extends Document {
  year: number;
  status: PremiumYearStatus;
  /**
   * Redistribution de la taxe environnementale, en francs par assuré et par an.
   * Elle est déduite de la prime brute : le fichier de l'OFSP ne la contient
   * pas, elle est fixée séparément (61.80 pour 2026, soit 5.15 par mois).
   */
  redistributionYearly: number;
  premiumRows: number;
  regionRows: number;
  insurerRows: number;
  sources: PremiumSource[];
  activatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const premiumYearSchema = new Schema<IPremiumYear>({
  year: { type: Number, required: true, unique: true, index: true },
  status: {
    type: String,
    required: true,
    enum: PREMIUM_YEAR_STATUSES,
    default: 'DRAFT',
    index: true
  },
  redistributionYearly: {
    type: Number,
    required: true,
    min: [0, 'La redistribution ne peut pas être négative.']
  },
  premiumRows: { type: Number, required: true, default: 0 },
  regionRows: { type: Number, required: true, default: 0 },
  insurerRows: { type: Number, required: true, default: 0 },
  sources: [{
    _id: false,
    kind: { type: String, required: true, enum: SOURCE_KINDS },
    filename: { type: String, required: true },
    sha256: { type: String, required: true },
    size: { type: Number, required: true },
    rows: { type: Number, required: true },
    origin: { type: String, required: true, enum: ['UPLOAD', 'DOWNLOAD'] },
    importedAt: { type: Date, required: true },
    importedBy: { type: String }
  }],
  activatedAt: { type: Date }
}, {
  collection: 'md_premium_year',
  timestamps: true
});

export const PremiumYear = model<IPremiumYear>('PremiumYear', premiumYearSchema);

export interface IPremium extends Document {
  year: number;
  insurerId: number;
  canton: string;
  /** Région de primes : 0 à 3. Le canton peut n'en avoir qu'une (0). */
  region: number;
  ageClass: AgeClass;
  /**
   * Sous-groupe d'âge, renseigné pour les enfants seulement : K1 est le tarif
   * normal, K3 à K5 les rabais familiaux à partir du troisième enfant. Sans
   * ce filtre, un enfant seul se verrait attribuer un tarif de fratrie
   * nombreuse et la comparaison serait faussée à la baisse.
   */
  ageSubgroup?: string;
  /** Vrai si la prime inclut la couverture accident. */
  withAccident: boolean;
  tariffType: TariffType;
  tariffCode: string;
  tariffName?: string;
  franchise: number;
  /** Prime mensuelle brute, avant déduction de la redistribution. */
  premium: number;
  isBase: boolean;
}

const premiumSchema = new Schema<IPremium>({
  year: { type: Number, required: true },
  insurerId: { type: Number, required: true },
  canton: { type: String, required: true },
  region: { type: Number, required: true },
  ageClass: { type: String, required: true, enum: AGE_CLASSES },
  ageSubgroup: { type: String },
  withAccident: { type: Boolean, required: true },
  tariffType: { type: String, required: true, enum: TARIFF_TYPES },
  tariffCode: { type: String, required: true },
  tariffName: { type: String },
  franchise: { type: Number, required: true },
  premium: { type: Number, required: true },
  isBase: { type: Boolean, required: true, default: false }
}, {
  collection: 'md_premium',
  // Documents figés, écrits en masse puis seulement lus : les horodatages
  // n'apporteraient rien et coûteraient 217 000 écritures de plus.
  timestamps: false,
  versionKey: false
});

// Requête principale : toutes les offres d'un assuré donné dans sa région.
premiumSchema.index({
  year: 1, canton: 1, region: 1, ageClass: 1, ageSubgroup: 1, withAccident: 1, franchise: 1
});
premiumSchema.index({ year: 1, insurerId: 1 });

export const Premium = model<IPremium>('Premium', premiumSchema);

export interface IPremiumRegion extends Document {
  year: number;
  plz: string;
  locality: string;
  canton: string;
  region: number;
  bfsNumber: number;
  commune: string;
}

const premiumRegionSchema = new Schema<IPremiumRegion>({
  year: { type: Number, required: true },
  plz: { type: String, required: true },
  locality: { type: String, required: true },
  canton: { type: String, required: true },
  region: { type: Number, required: true },
  bfsNumber: { type: Number, required: true },
  commune: { type: String, required: true }
}, {
  collection: 'md_premium_region',
  timestamps: false,
  versionKey: false
});

// Un NPA peut couvrir plusieurs communes, donc plusieurs régions : l'index
// n'est pas unique, la levée d'ambiguïté se fait par la localité.
premiumRegionSchema.index({ year: 1, plz: 1 });

export const PremiumRegion = model<IPremiumRegion>('PremiumRegion', premiumRegionSchema);

export interface IPremiumInsurer extends Document {
  year: number;
  insurerId: number;
  name: string;
  locality?: string;
}

const premiumInsurerSchema = new Schema<IPremiumInsurer>({
  year: { type: Number, required: true },
  insurerId: { type: Number, required: true },
  name: { type: String, required: true },
  locality: { type: String }
}, {
  collection: 'md_premium_insurer',
  timestamps: false,
  versionKey: false
});

premiumInsurerSchema.index({ year: 1, insurerId: 1 }, { unique: true });

export const PremiumInsurer = model<IPremiumInsurer>('PremiumInsurer', premiumInsurerSchema);
