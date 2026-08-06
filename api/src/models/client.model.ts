import { Schema, model, Document } from 'mongoose';
import { randomUUID } from 'crypto';

export const CANTONS = [
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU',
  'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS',
  'ZG', 'ZH'
] as const;

export type Canton = typeof CANTONS[number];
export type Sexe = 'M' | 'F' | 'X';

export interface IClient extends Document {
  uid: string;
  userUid: string;
  name: string;
  firstname: string;
  birthdate: Date;
  email: string;
  phone: string;
  road: string;
  plz: string;
  location: string;
  canton: Canton;
  nationality: string;
  avsNum: string;
  sexe: Sexe;
  blocked: boolean;
  blockedAt?: Date;
}

const clientSchema = new Schema<IClient>({
  uid: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => randomUUID()
  },
  // Rattache le client au md_user qui l'a créé (un user peut avoir plusieurs clients)
  userUid: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: [true, 'Le nom est obligatoire.'],
    trim: true
  },
  firstname: {
    type: String,
    required: [true, 'Le prénom est obligatoire.'],
    trim: true
  },
  birthdate: {
    type: Date,
    required: [true, 'La date de naissance est obligatoire.']
  },
  email: {
    type: String,
    required: [true, 'L\'email est obligatoire.'],
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    required: [true, 'Le téléphone est obligatoire.'],
    trim: true
  },
  road: {
    type: String,
    required: [true, 'La rue est obligatoire.'],
    trim: true
  },
  plz: {
    type: String,
    required: [true, 'Le NPA est obligatoire.'],
    trim: true,
    match: [/^\d{4}$/, 'Le NPA doit comporter 4 chiffres.']
  },
  location: {
    type: String,
    required: [true, 'La localité est obligatoire.'],
    trim: true
  },
  canton: {
    type: String,
    required: [true, 'Le canton est obligatoire.'],
    enum: { values: CANTONS, message: 'Canton invalide.' }
  },
  nationality: {
    type: String,
    required: [true, 'La nationalité est obligatoire.'],
    trim: true
  },
  // Numéro AVS suisse : 756.XXXX.XXXX.XX
  avsNum: {
    type: String,
    required: [true, 'Le numéro AVS est obligatoire.'],
    trim: true,
    match: [/^756\.\d{4}\.\d{4}\.\d{2}$/, 'Le numéro AVS doit être au format 756.XXXX.XXXX.XX.']
  },
  sexe: {
    type: String,
    required: [true, 'Le sexe est obligatoire.'],
    enum: { values: ['M', 'F', 'X'], message: 'Sexe invalide.' }
  },
  // Blocage administratif : le dossier subsiste mais devient inexploitable.
  blocked: {
    type: Boolean,
    required: true,
    default: false,
    index: true
  },
  blockedAt: {
    type: Date
  }
}, {
  collection: 'md_client'
});

export const Client = model<IClient>('Client', clientSchema);
