FROM node:20-alpine

WORKDIR /app

# Installation des dépendances de production
COPY package*.json ./
RUN npm install

# Copie des fichiers source
COPY . .

# Build TypeScript
RUN npm run build

# Exposition du port
EXPOSE 3000

# Démarrage de l'application
CMD ["npm", "start"] 