import { Schema, model, Document } from 'mongoose';

/** Durée de vie d'une session mobile. */
export const USER_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 jours

export interface IUserToken extends Document {
  tokenHash: string;
  userUid: string;
  createdAt: Date;
  expiresAt: Date;
}

const userTokenSchema = new Schema<IUserToken>({
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userUid: {
    type: String,
    required: true,
    index: true
  },
  createdAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  // Index TTL : MongoDB purge les jetons expirés tout seul.
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }
  }
}, {
  collection: 'md_user_token'
});

export const UserToken = model<IUserToken>('UserToken', userTokenSchema);
