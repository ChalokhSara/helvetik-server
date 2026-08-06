# Collection Bruno — API Helvetik

Collection de test de l'API mobile (`/api/*`). Ouvrir Bruno → **Open Collection**
→ sélectionner ce dossier `bruno/`, puis choisir l'environnement **Local** en
haut à droite.

## Démarrer la pile

```bash
docker compose up          # API + MongoDB + Mailpit
```

| Service | Adresse |
|---|---|
| API | <http://localhost:3000> |
| Console admin | <http://localhost:3000/admin> |
| Swagger | <http://localhost:3000/api-docs> |
| Mailpit (boîte de réception) | <http://localhost:8025> |

Pour lancer l'API hors conteneur (`cd api && npm run dev`), gardez au moins
MongoDB et Mailpit dans Docker : `docker compose up mongodb mailpit`. Les ports
27017, 1025 et 8025 sont publiés sur la machine hôte, et le `.env` pointe déjà
sur `localhost`.

Vérifier avec la requête **Health / Healthcheck**.

## Parcours nominal

Le dossier `Auth` se joue dans l'ordre, sans aucune saisie manuelle :

| # | Requête | Effet |
|---|---|---|
| 1 | `01 Register` | Crée le compte + le client titulaire, envoie l'email |
| 2 | `02 Get token from Mailpit` | Lit l'email dans Mailpit, extrait le jeton → `confirmToken` |
| 3 | `03 Confirm email` | Confirme l'adresse |
| 4 | `04 Login` | Récupère le jeton de session → `authToken` |
| 5 | `05 Me` | Compte courant et clients rattachés |
| 6 | `06 Resend confirmation` | Renvoie un email de confirmation |

Puis `Clients` (ajout d'un membre de la famille), `Insurances` (ajout d'un
contrat, listing filtré du foyer) et `Comparison` (lien priminfo prérempli,
puis optimisation LAMal avec les primes réelles en JSON).

Les variables `confirmToken`, `authToken`, `userUid`, `clientUid` et
`insuranceUid` sont alimentées par les scripts post-réponse : aucun
copier-coller.

## Lancer toute la collection

Les dossiers sont numérotés pour s'enchaîner : Health → Auth → Clients →
Insurances → Comparison → Erreurs → Session. Depuis le **Runner** de Bruno, ou
en ligne de commande :

```bash
cd bruno && npx @usebruno/cli run --env Local
```

Sur une base vierge, les 22 requêtes et 61 tests doivent passer.

`Logout` est isolé dans le dossier `Session`, ordonné en dernier : au milieu du
flux, il invalidait `authToken` et faisait échouer en 401 tout ce qui suivait.

## Comment le jeton de confirmation est récupéré

L'API ne renvoie **jamais** le jeton dans une réponse HTTP, et la base n'en
stocke que l'empreinte SHA-256 : il ne sort que par email, exactement comme en
production. Aucune route de contournement n'a été ajoutée pour les tests.

Ce qui rend l'automatisation possible, c'est **Mailpit** : un serveur SMTP de
développement qui capture tous les emails sans jamais les transmettre à
l'extérieur, et expose une API REST. La requête `02 Get token from Mailpit`
interroge la boîte de réception, pas l'API Helvetik.

Les emails restent consultables à l'œil sur <http://localhost:8025>, avec les
liens cliquables.

## Rejouer les tests

`01 Register` renvoie **409** si le compte existe déjà. Deux options :

- changer `userEmail` dans l'environnement (`anna2@example.com`, …) ;
- ou repartir d'une base vide :

```bash
docker compose exec mongodb mongosh insurance-app --quiet \
  --eval 'db.md_user.deleteMany({}); db.md_client.deleteMany({}); db.md_user_token.deleteMany({}); db.md_insurance.deleteMany({})'
```

Le super admin (`md_admin`) n'est pas touché par cette commande. Si vous videz
aussi `md_admin`, il sera recréé au prochain démarrage avec `root` / `helvetik`
et le changement de mot de passe obligatoire.

Pour vider la boîte de réception : bouton *Delete all* dans Mailpit, ou
`curl -X DELETE http://localhost:8025/api/v1/messages`.

## Dossier `Comparison`

`02 LAMal optimisation` calcule les primes à partir des **données officielles
de l'OFSP importées en base** (console → Primes officielles). Réponse en
quelques millisecondes, sans appel sortant.

Tant qu'aucune année n'est mise en service, la route bascule automatiquement
sur l'interrogation de priminfo.admin.ch : mêmes chiffres, mais une seconde
environ au premier appel. Le champ `source.provider` de la réponse indique
laquelle des deux voies a servi.

Elle exige un **contrat LAMal en vigueur chez un assureur maladie reconnu** —
l'optimisation compare vos primes à ce que vous payez aujourd'hui. Un
prestataire qui ne pratique pas la LAMal (Helvetia, la Baloise…) renvoie
**400** `CURRENT_LAMAL_REQUIRED`.

## Primes officielles

Trois fichiers publiés chaque année par l'OFSP alimentent le calcul : le
répertoire des primes, les régions de primes et la liste des assureurs admis.
Ils se déposent depuis <http://localhost:3000/admin/premiums>, ou se
téléchargent d'un clic depuis priminfo. Un contrôle mensuel automatique les
récupère et les importe en état « préparée » ; la mise en service reste un
geste d'administrateur.

## Dossier `Erreurs`

Les cas d'échec valent autant que le parcours nominal : format AVS, canton hors
liste, messages non énumérants, protection des routes, révocation de jeton.
Chaque requête documente dans son onglet **Docs** les variantes à essayer en
modifiant un champ.

## Console d'administration

Elle n'est pas couverte ici : c'est une interface HTML sur session par cookie
avec jeton anti-CSRF par formulaire, faite pour un navigateur, pas pour un
client REST. Elle se teste sur <http://localhost:3000/admin> — utilisateurs,
clients et assurances y sont gérés en création, modification et suppression.
