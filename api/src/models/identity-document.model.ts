import { Schema, model, Document } from 'mongoose';
import { randomUUID } from 'crypto';

/**
 * Documents personnels déposés par les assurés (md_identity_document).
 *
 * Deux natures, un même coffre : les deux faces de la pièce d'identité, et la
 * signature manuscrite. Toutes trois servent aux courriers adressés aux
 * caisses — une résiliation doit être signée et accompagnée d'une copie de la
 * pièce — et toutes trois demandent les mêmes précautions.
 *
 * Ce sont les données les plus sensibles de la base. Le contenu est **chiffré**
 * (AES-256-GCM, cf. document-vault.service) et n'est jamais renvoyé par une
 * lecture ordinaire : `select: false` oblige chaque appelant à le demander.
 *
 * Un document par nature et par assuré ; un nouveau dépôt remplace l'ancien.
 */

export const DOCUMENT_KINDS = ['RECTO', 'VERSO', 'SIGNATURE'] as const;
export type DocumentKind = typeof DOCUMENT_KINDS[number];

/** Les deux faces de la pièce d'identité, à demander ensemble. */
export const IDENTITY_KINDS = ['RECTO', 'VERSO'] as const;

export const KIND_LABELS: Record<DocumentKind, string> = {
  RECTO: 'recto',
  VERSO: 'verso',
  SIGNATURE: 'signature'
};

// Anciens noms, conservés le temps que les appelants soient tous convertis.
export const DOCUMENT_SIDES = IDENTITY_KINDS;
export type DocumentSide = DocumentKind;
export const SIDE_LABELS = KIND_LABELS;

export interface IIdentityDocument extends Document {
  uid: string;
  userUid: string;
  clientUid: string;
  kind: DocumentKind;
  /** Type du fichier d'origine, nécessaire pour le restituer tel quel. */
  mimetype: string;
  filename: string;
  /** Taille en clair, avant chiffrement : celle qui sera restituée. */
  size: number;
  /** Contenu chiffré. Jamais chargé sans demande explicite. */
  data: Buffer;
  /** Vecteur d'initialisation, unique par document. */
  iv: Buffer;
  /** Étiquette d'authentification GCM : détecte toute altération. */
  authTag: Buffer;
  /** Empreinte du clair, pour reconnaître un dépôt identique. */
  checksum: string;
  uploadedAt: Date;
  /** Dernière restitution du fichier, quel que soit le demandeur. */
  lastAccessedAt?: Date;
  accessCount: number;
}

const identityDocumentSchema = new Schema<IIdentityDocument>({
  uid: {
    type: String,
    required: true,
    unique: true,
    default: () => randomUUID()
  },
  userUid: {
    type: String,
    required: true,
    index: true
  },
  clientUid: {
    type: String,
    required: true,
    index: true
  },
  kind: {
    type: String,
    required: true,
    enum: { values: DOCUMENT_KINDS, message: 'Nature de document invalide.' }
  },
  mimetype: {
    type: String,
    required: true
  },
  filename: {
    type: String,
    required: true
  },
  size: {
    type: Number,
    required: true
  },
  data: {
    type: Buffer,
    required: true,
    select: false
  },
  iv: {
    type: Buffer,
    required: true,
    select: false
  },
  authTag: {
    type: Buffer,
    required: true,
    select: false
  },
  checksum: {
    type: String,
    required: true
  },
  uploadedAt: {
    type: Date,
    required: true,
    default: () => new Date()
  },
  lastAccessedAt: {
    type: Date
  },
  accessCount: {
    type: Number,
    required: true,
    default: 0
  }
}, {
  collection: 'md_identity_document'
});

// Un seul document par nature et par assuré : un dépôt remplace l'ancien.
identityDocumentSchema.index({ clientUid: 1, kind: 1 }, { unique: true });

export const IdentityDocument = model<IIdentityDocument>(
  'IdentityDocument',
  identityDocumentSchema
);
