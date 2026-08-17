import { Schema, model, Document } from 'mongoose';
import { randomUUID } from 'crypto';

/**
 * Pièces d'identité déposées par les assurés (md_identity_document).
 *
 * Elles ne servent pas qu'à la reconnaissance de texte : une lettre de
 * résiliation ou d'affiliation doit être accompagnée d'une copie de la pièce.
 * Il faut donc les conserver, et non plus seulement les lire puis les effacer.
 *
 * Conséquence directe : ce sont les données les plus sensibles de toute la
 * base. Le contenu est **chiffré** (AES-256-GCM, cf. document-vault.service)
 * et n'est jamais renvoyé par une lecture ordinaire — `select: false` oblige
 * chaque appelant à le demander explicitement.
 *
 * Une pièce par face et par assuré : le recto porte la photo, le verso la
 * bande lisible par machine. Les deux sont exigées par les caisses.
 */

export const DOCUMENT_SIDES = ['RECTO', 'VERSO'] as const;
export type DocumentSide = typeof DOCUMENT_SIDES[number];

export const SIDE_LABELS: Record<DocumentSide, string> = {
  RECTO: 'recto',
  VERSO: 'verso'
};

export interface IIdentityDocument extends Document {
  uid: string;
  userUid: string;
  clientUid: string;
  side: DocumentSide;
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
  side: {
    type: String,
    required: true,
    enum: { values: DOCUMENT_SIDES, message: 'Face invalide.' }
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

// Une seule pièce par face et par assuré : un nouveau dépôt remplace l'ancien.
identityDocumentSchema.index({ clientUid: 1, side: 1 }, { unique: true });

export const IdentityDocument = model<IIdentityDocument>(
  'IdentityDocument',
  identityDocumentSchema
);
