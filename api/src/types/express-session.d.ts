import 'express-session';

declare module 'express-session' {
  interface SessionData {
    adminUid?: string;
    adminUsername?: string;
    mustChangePassword?: boolean;
    csrfToken?: string;
    /** Assuré connecté au site web (distinct de la console d'administration). */
    siteUserUid?: string;
  }
}
