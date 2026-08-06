import 'express-session';

declare module 'express-session' {
  interface SessionData {
    adminUid?: string;
    adminUsername?: string;
    mustChangePassword?: boolean;
    csrfToken?: string;
  }
}
