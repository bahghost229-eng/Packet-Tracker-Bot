# Déploiement Railway — Packet Tracker Bot

## 1. Prérequis

- Compte [Railway](https://railway.app) (gratuit suffit pour démarrer)
- Repo GitHub : `bahghost229-eng/Packet-Tracker-Bot`
- Tes variables d'environnement prêtes (voir section 4)

---

## 2. Créer le projet Railway

1. Va sur [railway.app](https://railway.app) → **New Project**
2. Choisis **Deploy from GitHub repo**
3. Sélectionne `Packet-Tracker-Bot`
4. Railway détecte automatiquement Node.js via `nixpacks`

---

## 3. Ajouter un Volume (IMPORTANT — persistance DB)

> Sans volume, la DB SQLite est effacée à chaque redeploy.

1. Dans ton projet Railway → **+ New** → **Volume**
2. Monte le volume sur le service bot :
   - **Mount Path** : `/data`
3. Dans les variables d'env (section 4), ajoute :
   ```
   DB_PATH=/data/tracker.db
   ```

---

## 4. Variables d'environnement

Dans Railway → ton service → **Variables** → ajoute chaque ligne :

```env
TELEGRAM_BOT_TOKEN=ton_token_botfather

HELIUS_API_KEY=ta_cle_helius
HELIUS_RPC_HTTP=https://mainnet.helius-rpc.com/?api-key=ta_cle_helius
HELIUS_RPC_WSS=wss://mainnet.helius-rpc.com/?api-key=ta_cle_helius

FALLBACK_RPC_HTTP=https://api.mainnet-beta.solana.com
FALLBACK_RPC_WSS=wss://api.mainnet-beta.solana.com

ALLOWED_USER_IDS=ton_telegram_id

LOG_LEVEL=info
DB_PATH=/data/tracker.db
CHAIN_HOP_TIMEOUT_MS=30000
WS_RECONNECT_DELAY_MS=3000

# Optionnel TradeWiz
TRADEWIZ_CHAT_ID=
TRADEWIZ_BOT_NAME=CopyTrade
```

> 💡 Ton Telegram ID : envoie `/start` à [@userinfobot](https://t.me/userinfobot)

---

## 5. Configurer le service comme Worker

Le bot Telegram est un **worker** (pas un serveur HTTP — pas de port exposé).

Dans Railway → ton service → **Settings** :
- **Start Command** : `node src/index.js`
- Ou laisse Railway utiliser le `Procfile` automatiquement

> ⚠️ Ne pas activer "Public Networking" — le bot n'a pas besoin d'un port exposé.

---

## 6. Déployer

1. Railway lance le build automatiquement après connexion GitHub
2. Vérifie les logs : **Deployments** → **View Logs**
3. Tu dois voir :
   ```
   [DB] Nouvelle base créée
   [DB] Tables initialisées
   Bot started: @ton_bot_username
   ```

---

## 7. Redéploiement automatique

Chaque `git push origin main` → Railway redéploie automatiquement.

---

## 8. Troubleshooting

| Problème | Solution |
|----------|----------|
| `Error: TELEGRAM_BOT_TOKEN not set` | Variable manquante dans Railway |
| Bot démarre puis s'arrête | Vérifie `ALLOWED_USER_IDS` — doit être ton vrai ID |
| DB perdue après redeploy | Volume non monté ou `DB_PATH` ne pointe pas vers `/data/` |
| `409 Conflict` | Deux instances du bot tournent — arrête l'ancienne |
| Helius rate limit | Vérifie ta clé Helius, passe au plan payant si nécessaire |

---

## 9. Plan Railway recommandé

- **Hobby** ($5/mois) : suffisant, 512MB RAM, volumes inclus
- **Free tier** : limité (500h/mois, pas de volumes persistants) → **évite pour la prod**
