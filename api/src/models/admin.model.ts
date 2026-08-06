import { Schema, model, Document } from 'mongoose';
import { randomUUID } from 'crypto';

export interface IAdmin extends Document {
  uid: string;
  username: string;
  email: string;
  password: string;
  salt: string;
  mustChangePassword: boolean;
}

const adminSchema = new Schema<IAdmin>({
  uid: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => randomUUID()
  },
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
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
  // Force le passage par /admin/password avant tout accès à la console.
  mustChangePassword: {
    type: Boolean,
    required: true,
    default: false
  }
}, {
  collection: 'md_admin'
});

export const Admin = model<IAdmin>('Admin', adminSchema);
