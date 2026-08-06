import { Request, Response, NextFunction } from 'express';
import { User } from '../models/user.model';
import { UserToken } from '../models/user-token.model';
import { hashToken } from '../utils/token';

/**
 * Authentification de l'application mobile : `Authorization: Bearer <token>`.
 *
 * Le jeton est opaque et son empreinte est vérifiée en base à chaque requête.
 * L'utilisateur est rechargé dans la foulée, ce qui rend un blocage
 * administratif effectif immédiatement, sans attendre l'expiration du jeton.
 */
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      code: 'UNAUTHENTICATED',
      message: 'Jeton d\'authentification manquant.'
    });
  }

  try {
    const session = await UserToken.findOne({ tokenHash: hashToken(token) });
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      return res.status(401).json({
        code: 'INVALID_TOKEN',
        message: 'Session expirée ou invalide.'
      });
    }

    const user = await User.findOne({ uid: session.userUid });
    if (!user) {
      await UserToken.deleteOne({ _id: session._id });
      return res.status(401).json({
        code: 'INVALID_TOKEN',
        message: 'Session expirée ou invalide.'
      });
    }

    if (user.blocked) {
      return res.status(403).json({
        code: 'ACCOUNT_BLOCKED',
        message: 'Ce compte est bloqué.'
      });
    }

    req.authUser = user;
    next();
  } catch (err) {
    console.error('Erreur d\'authentification:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Erreur serveur.' });
  }
}
