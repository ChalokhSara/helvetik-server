import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import session from 'express-session';
import swaggerUi from 'swagger-ui-express';
import { specs } from './config/swagger';
import { authRouter } from './routes/auth.routes';
import { healthcheckRouter } from './routes/healthcheck';
import { keycloak, memoryStore } from './config/keycloak';

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Session config
app.use(session({
  secret: 'some secret',
  resave: false,
  saveUninitialized: true,
  store: memoryStore
}));

// Keycloak middleware
app.use(keycloak.middleware());

// Documentation Swagger
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

// Routes
app.use('/health', healthcheckRouter);
app.use('/api/auth', authRouter);

// Connexion MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://mongodb:27017/insurance-app')
  .then(() => console.log('Connecté à MongoDB'))
  .catch((err) => console.error('Erreur de connexion MongoDB:', err));

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

export default app; 