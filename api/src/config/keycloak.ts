import KeycloakConnect from 'keycloak-connect';
import session from 'express-session';

const memoryStore = new session.MemoryStore();

const keycloakConfig = {
  "realm": process.env.KEYCLOAK_REALM || "Helvetik",
  "auth-server-url": process.env.KEYCLOAK_URL || "http://localhost:8080",
  "ssl-required": "external",
  "resource": process.env.KEYCLOAK_CLIENT_ID || "helvetik-backend",
  "confidential-port": 0,
  "verify-token-audience": true,
  "use-resource-role-mappings": false,
  "enable-cors": true,
  "credentials": {
    "secret": process.env.KEYCLOAK_CLIENT_SECRET
  }
};

const keycloak = new KeycloakConnect({ store: memoryStore }, keycloakConfig);

export { keycloak, memoryStore }; 