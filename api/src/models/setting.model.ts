import { Schema, model, Document } from 'mongoose';

/**
 * Réglages modifiables depuis la console d'administration.
 *
 * Stockage clé/valeur volontairement générique : ajouter un réglage revient à
 * ajouter une clé, sans migration ni changement de schéma.
 *
 * Les variables d'environnement gardent leur rôle : elles fournissent la
 * valeur initiale, celle qui s'applique tant que personne n'a rien changé.
 * Dès qu'un administrateur enregistre une valeur, c'est la base qui fait foi —
 * sinon un redéploiement écraserait silencieusement son choix.
 */

export const SETTING_KEYS = ['EMAIL_CONFIRMATION_REQUIRED'] as const;
export type SettingKey = typeof SETTING_KEYS[number];

export interface ISetting extends Document {
  key: SettingKey;
  value: string;
  updatedBy?: string;
  updatedAt: Date;
  createdAt: Date;
}

const settingSchema = new Schema<ISetting>({
  key: {
    type: String,
    required: true,
    unique: true,
    index: true,
    enum: SETTING_KEYS
  },
  // Toujours une chaîne : la conversion appartient au lecteur du réglage,
  // qui seul sait s'il attend un booléen, un nombre ou du texte.
  value: { type: String, required: true },
  updatedBy: { type: String }
}, {
  collection: 'md_setting',
  timestamps: true
});

export const Setting = model<ISetting>('Setting', settingSchema);
