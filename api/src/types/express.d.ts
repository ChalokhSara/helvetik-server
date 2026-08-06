import { IUser } from '../models/user.model';

declare global {
  namespace Express {
    interface Request {
      /** Utilisateur mobile authentifié par jeton Bearer (cf. middleware/require-user). */
      authUser?: IUser;
    }
  }
}

export {};
