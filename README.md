# MVP V1 — Plateforme de gestion de tontines

Application web complète (Node.js + Express + SQLite) implémentant le périmètre du
cahier des charges MVP V1 v2 : authentification par OTP, création et adhésion aux
tontines, cycles et tirage au sort, cotisations avec preuve de paiement obligatoire
au-delà d'un seuil, gestion des impayés/retards, litiges, journal d'audit, tableau
de bord, notifications (in-app + SMS simulé) et rapports imprimables.

## Installation

```bash
npm install
npm start
```

L'application démarre sur **http://localhost:3000**.

Aucune configuration externe n'est nécessaire : une base SQLite (`data/tontines.db`)
est créée automatiquement au premier lancement.

## Compte de démonstration — authentification OTP

Il n'y a pas d'intégration SMS réelle dans ce MVP. Lors de l'inscription ou de la
connexion, le code OTP à 6 chiffres est :
- affiché directement à l'écran (bandeau « Mode démo »)
- et imprimé dans la console du serveur (`[OTP SIMULÉ] ...`)

Pour un déploiement réel, brancher un fournisseur SMS (Twilio, Orange SMS API,
Africa's Talking, etc.) dans `src/routes/auth.js` (fonction `sendOtp`) et dans
`src/utils/audit.js` (fonction `notify`, canal `sms`).

## Parcours à tester

1. S'inscrire (prénom, nom, téléphone) → accepter la politique de confidentialité → valider l'OTP affiché à l'écran
2. Créer une tontine (montant, fréquence, nombre de cycles, seuil de preuve, double validation)
3. Copier le code d'invitation affiché sur la page de la tontine
4. Se déconnecter, créer un second compte, rejoindre la tontine avec le code
5. Revenir sur le compte administrateur → lancer le tirage au sort
6. Enregistrer une cotisation (tester le blocage si le montant dépasse le seuil de preuve sans fichier joint)
7. Confirmer la remise du pot (si double validation activée, se connecter avec le compte trésorier pour la seconde confirmation)
8. Signaler un litige avec le compte membre, le résoudre avec le compte administrateur
9. Consulter le journal d'audit, l'historique et le rapport imprimable (bouton "Imprimer / Exporter en PDF")

## Structure du projet

```
server.js                  Point d'entrée Express
src/db.js                  Schéma SQLite (création automatique des tables)
src/middleware/auth.js     Authentification de session + contrôle des rôles par tontine
src/utils/audit.js         Journal d'audit + notifications (in-app / SMS simulé)
src/utils/business.js      Génération des cycles, détection des retards/impayés
src/routes/auth.js         Inscription, connexion par OTP
src/routes/tontines.js     Tontines, membres, cycles, tirage, cotisations, litiges, rapports
views/                     Templates EJS (Bootstrap 5)
public/                    CSS, fichiers uploadés (preuves de paiement)
data/                      Base SQLite (créée automatiquement, à ne pas committer)
```

## Hors périmètre de ce MVP (cf. cahier des charges, section 12)

Portefeuille électronique, conservation/transfert de fonds, paiement Mobile Money
intégré, crédit, microfinance, assurance, scoring financier avancé — prévus dans
les phases ultérieures de la roadmap (V1.1 et évolution fintech).

## Sécurité — points à durcir avant une mise en production

- Remplacer `SESSION_SECRET` par une valeur secrète forte (variable d'environnement)
- Brancher un vrai fournisseur OTP/SMS et limiter le taux de tentatives (rate limiting)
- Servir l'application derrière HTTPS
- Restreindre la taille/le type des fichiers de preuve de paiement au niveau serveur (déjà limité à 5 Mo côté `multer`)
- Sauvegardes régulières de `data/tontines.db`
