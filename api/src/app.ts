import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import swaggerUi from 'swagger-ui-express';
import { specs } from './config/swagger';
import { ensureSuperAdmin } from './config/seed';
import { startScheduler } from './config/scheduler';
import { emailConfirmationRequired, loadSettings, startSettingsRefresh } from './config/features';
import { checkVaultConfiguration } from './services/document-vault.service';
import { checkLlmAvailability } from './services/policy-llm.service';
import { authRouter } from './routes/auth.routes';
import { clientsRouter } from './routes/clients.routes';
import { insurancesRouter } from './routes/insurances.routes';
import { comparisonRouter } from './routes/comparison.routes';
import { adminRouter } from './routes/admin.routes';
import { siteRouter } from './routes/site.routes';
import { healthcheckRouter } from './routes/healthcheck';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongodb:27017/insurance-app';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 1 semaine
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Refus de démarrer en production avec le secret de session par défaut :
 * quiconque le connaît peut forger un cookie de session valide, y compris
 * celui d'un administrateur.
 */
if (IS_PRODUCTION && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-only-secret')) {
  console.error(
    '[config] SESSION_SECRET absent ou laissé à sa valeur de développement. ' +
    'Définissez un secret aléatoire avant de démarrer en production.'
  );
  process.exit(1);
}

const app = express();

// Derrière un proxy (nginx, Traefik…), faire confiance aux en-têtes
// X-Forwarded-* pour que req.protocol et req.host reflètent l'adresse publique.
if (process.env.TRUST_PROXY) {
  const value = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value);
}

// Middleware
app.use(cors());
app.use(express.json());

// Session (console d'administration desktop), persistée dans MongoDB pour
// survivre aux redémarrages. Expiration à une semaine, glissante.
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  name: 'helvetik.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: MongoStore.create({
    mongoUrl: MONGODB_URI,
    collectionName: 'md_session',
    ttl: SESSION_TTL_SECONDS
  }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_SECONDS * 1000
  }
}));

// Documentation Swagger
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

// Routes
app.use('/health', healthcheckRouter);
app.use('/api/auth', authRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/insurances', insurancesRouter);
app.use('/api/comparison', comparisonRouter);
app.use('/admin', adminRouter);
// Le site des assurés est monté en dernier : il occupe la racine et ne doit
// masquer ni l'API, ni la console, ni la documentation.
app.use('/', siteRouter);

// Connexion MongoDB
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('Connecté à MongoDB');
    await ensureSuperAdmin();
    // Les réglages vivent en base : les charger avant de servir la première requête.
    await loadSettings();
    startSettingsRefresh();
    // Signalé ici et non dans la bannière : celle-ci s'affiche à l'écoute du
    // port, avant que la base ne soit lue, et annoncerait donc l'état de la
    // configuration plutôt que celui du réglage réellement en vigueur.
    console.log(`[réglages] confirmation d'email : ${
      emailConfirmationRequired() ? 'exigée' : 'DÉSACTIVÉE — les comptes sont actifs sans vérification'}.`);
    // Après la connexion : les tâches de fond lisent la base dès leur premier tour.
    startScheduler();
  })
  .catch((err) => console.error('Erreur de connexion MongoDB:', err));

const PORT = process.env.PORT || 3000;

/**
 * Récapitulatif au démarrage : savoir d'un coup d'œil dans quel environnement
 * on tourne et où partent les emails évite les mauvaises surprises — un envoi
 * réel depuis une machine de test se remarque trop tard.
 */
function logEnvironment(): void {
  const mail = process.env.SMTP_HOST
    ? `${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 1025}` +
      (process.env.SMTP_USER ? ' (authentifié)' : ' (anonyme)')
    : 'aucun — les emails partent dans les logs';

  console.log('┌─ Helvetik ' + '─'.repeat(52));
  console.log(`│ environnement : ${IS_PRODUCTION ? 'PRODUCTION — les emails partent réellement' : 'développement'}`);
  console.log(`│ emails        : ${mail}`);
  console.log(`│ liens emails  : ${IS_PRODUCTION
    ? (process.env.APP_BASE_URL || 'NON CONFIGURÉ')
    : `déduits de la requête (repli : ${process.env.APP_BASE_URL || `http://localhost:${PORT}`})`}`);
  console.log(`│ base          : ${MONGODB_URI.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`│ pièces d'id.  : ${process.env.DOCUMENT_ENCRYPTION_KEY
    ? 'chiffrées avec DOCUMENT_ENCRYPTION_KEY'
    : 'chiffrées avec la CLÉ DE DÉVELOPPEMENT, publique'}`);
  console.log('└' + '─'.repeat(63));

  if (IS_PRODUCTION && !process.env.SMTP_HOST) {
    console.error(
      '[config] SMTP_HOST absent en production : aucun email ne sera envoyé et ' +
      'les comptes resteront inconfirmables.'
    );
  }
}

// Démarrage du serveur
app.listen(PORT, () => {
  logEnvironment();
  // Vérifié ici plutôt qu'au premier dépôt : un refus d'enregistrer une pièce
  // d'identité serait découvert par l'assuré, pas par l'exploitant.
  checkVaultConfiguration();
  // Sans attendre : un modèle encore en téléchargement ne doit pas retarder
  // le démarrage, la lecture des polices retombe simplement sur les motifs.
  void checkLlmAvailability();
  console.log(`Serveur démarré sur le port ${PORT}`);
});

export default app;
