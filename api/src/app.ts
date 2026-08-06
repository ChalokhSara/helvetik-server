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
import { authRouter } from './routes/auth.routes';
import { clientsRouter } from './routes/clients.routes';
import { insurancesRouter } from './routes/insurances.routes';
import { comparisonRouter } from './routes/comparison.routes';
import { adminRouter } from './routes/admin.routes';
import { healthcheckRouter } from './routes/healthcheck';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongodb:27017/insurance-app';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 1 semaine

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Session (console d'administration desktop), persistée dans MongoDB pour
// survivre aux redémarrages. Expiration à une semaine, glissante.
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
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

// Connexion MongoDB
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('Connecté à MongoDB');
    await ensureSuperAdmin();
    // Après la connexion : les tâches de fond lisent la base dès leur premier tour.
    startScheduler();
  })
  .catch((err) => console.error('Erreur de connexion MongoDB:', err));

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

export default app;
