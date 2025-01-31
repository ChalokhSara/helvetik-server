import { Router } from 'express';
import { keycloak } from '../config/keycloak';

const router = Router();

/**
 * @swagger
 * /api/auth/config:
 *   get:
 *     summary: Obtenir la configuration Keycloak
 *     description: Retourne la configuration nécessaire pour le client mobile
 *     responses:
 *       200:
 *         description: Configuration Keycloak
 */
router.get('/config', (req, res) => {
  res.json({
    'realm': 'Helvetik',
    'auth-server-url': process.env.KEYCLOAK_URL || 'http://localhost:8080',
    'ssl-required': 'external',
    'resource': 'helvetik-frontend',
    'public-client': true
  });
});

// Route protégée pour tester l'authentification
router.get('/status', keycloak.protect(), (req, res) => {
  res.json({ status: 'authenticated' });
});

/**
 * @swagger
 * /api/auth/public:
 *   get:
 *     summary: Route publique
 *     description: Accessible sans authentification
 *     responses:
 *       200:
 *         description: Succès
 */
router.get('/public', (req, res) => {
  res.json({ message: 'Route publique' });
});

/**
 * @swagger
 * /api/auth/protected:
 *   get:
 *     summary: Route protégée
 *     description: Nécessite une authentification
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Succès
 *       401:
 *         description: Non autorisé
 */
router.get('/protected', keycloak.protect(), (req, res) => {
  res.json({ 
    message: 'Route protégée',
    user: req.kauth?.grant?.access_token
  });
});

/**
 * @swagger
 * /api/auth/admin:
 *   get:
 *     summary: Route admin
 *     description: Nécessite un rôle admin
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Succès
 *       403:
 *         description: Accès refusé
 */
router.get('/admin', keycloak.protect('admin'), (req, res) => {
  res.json({ message: 'Route admin' });
});

export { router as authRouter }; 