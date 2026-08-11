import { IUser } from '../models/user.model';

declare global {
  namespace Express {
    interface Request {
      /** Utilisateur mobile authentifié par jeton Bearer (cf. middleware/require-user). */
      authUser?: IUser;
      /** Utilisateur du site web, authentifié par session (cf. routes/site.routes). */
      siteUser?: IUser;
    }
  }
}

export {};
