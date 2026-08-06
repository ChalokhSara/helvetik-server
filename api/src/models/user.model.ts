import { Schema, model, Document } from 'mongoose';
import { randomUUID } from 'crypto';

export interface IUser extends Document {
  uid: string;
  email: string;
  password: string;
  salt: string;
  creationDate: Date;
  lastLoginDate?: Date;
  blocked: boolean;
  blockedAt?: Date;
  emailVerified: boolean;
  emailVerifiedAt?: Date;
  /** Empreinte du jeton de confirmation : le jeton en clair ne vit que dans l'email. */
  emailTokenHash?: string;
  emailTokenExpiresAt?: Date;
}

const userSchema = new Schema<IUser>({
  uid: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => randomUUID()
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },
  password: {
    type: String,
    required: true,
    select: false
  },
  salt: {
    type: String,
    required: true,
    select: false
  },
  creationDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  lastLoginDate: {
    type: Date
  },
  // Blocage administratif : le compte subsiste mais l'accès est refusé.
  blocked: {
    type: Boolean,
    required: true,
    default: false,
    index: true
  },
  blockedAt: {
    type: Date
  },
  // Confirmation d'email : tant qu'elle n'est pas faite, le login est refusé.
  emailVerified: {
    type: Boolean,
    required: true,
    default: false,
    index: true
  },
  emailVerifiedAt: {
    type: Date
  },
  emailTokenHash: {
    type: String,
    select: false,
    index: true
  },
  emailTokenExpiresAt: {
    type: Date,
    select: false
  }
}, {
  collection: 'md_user'
});

export const User = model<IUser>('User', userSchema);
