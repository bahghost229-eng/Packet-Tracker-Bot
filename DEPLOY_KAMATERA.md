# Déploiement sur Kamatera — Packet Tracker Bot

## Ton serveur existant
- **IP** : `199.19.73.16`
- **Datacenter** : US-NY2
- **Specs** : 1 CPU · 1GB RAM · 20GB disk
- **Billing** : Monthly

---

## Étapes de déploiement

### 1. Connecte-toi en SSH

```bash
ssh root@199.19.73.16
```

Entre ton mot de passe root Kamatera.

---

### 2. Installe Node.js + clone le repo

Colle ce bloc **en une fois** dans le terminal SSH :

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git

# PM2 (keep-alive)
npm install -g pm2

# Clone le bot
git clone https://github.com/bahghost229-eng/Packet-Tracker-Bot.git /opt/packet-tracker-bot
cd /opt/packet-tracker-bot
npm ci --omit=dev

# Dossiers nécessaires
mkdir -p data logs
```

---

### 3. Configure le `.env`

```bash
cp /opt/packet-tracker-bot/.env.example /opt/packet-tracker-bot/.env
nano /opt/packet-tracker-bot/.env
```

Remplis ces variables (minimum requis) :

```env
TELEGRAM_BOT_TOKEN=ton_token_botfather
HELIUS_API_KEY=ta_cle_helius
HELIUS_RPC_HTTP=https://mainnet.helius-rpc.com/?api-key=ta_cle_helius
HELIUS_RPC_WSS=wss://mainnet.helius-rpc.com/?api-key=ta_cle_helius
FALLBACK_RPC_HTTP=https://api.mainnet-beta.solana.com
FALLBACK_RPC_WSS=wss://api.mainnet-beta.solana.com
ALLOWED_USER_IDS=ton_telegram_id
DB_PATH=/opt/packet-tracker-bot/data/tracker.db
LOG_LEVEL=info
```

Sauvegarde : `Ctrl+O` → `Entrée` → `Ctrl+X`

---

### 4. Lance le bot avec PM2

```bash
cd /opt/packet-tracker-bot
pm2 start src/index.js --name packet-tracker --max-restarts 10 --restart-delay 3000
pm2 save
pm2 startup
```

> La dernière commande `pm2 startup` affiche une ligne à copier-coller pour que le bot redémarre automatiquement au reboot du serveur.

---

### 5. Vérifie que ça tourne

```bash
pm2 status
pm2 logs packet-tracker --lines 30
```

Tu dois voir :
```
[DB] Tables initialisées
Bot started: @ton_bot_username
```

---

## Commandes utiles

```bash
pm2 restart packet-tracker    # Redémarrer
pm2 stop packet-tracker       # Arrêter
pm2 logs packet-tracker       # Logs en temps réel
pm2 monit                     # Dashboard CPU/RAM

# Mettre à jour le bot
cd /opt/packet-tracker-bot
git pull origin main
npm ci --omit=dev
pm2 restart packet-tracker
```

---

## Mise à jour automatique (optionnel)

Pour que le bot se mette à jour automatiquement à chaque push GitHub :

```bash
# Crontab — vérifie les mises à jour toutes les 5 min
crontab -e
```

Ajoute cette ligne :
```
*/5 * * * * cd /opt/packet-tracker-bot && git pull origin main --quiet && npm ci --omit=dev --quiet && pm2 restart packet-tracker --quiet
```

---

## Troubleshooting

| Problème | Solution |
|----------|----------|
| `TELEGRAM_BOT_TOKEN not set` | Variable manquante dans `.env` |
| `409 Conflict` | Deux instances tournent — `pm2 delete all && pm2 start...` |
| Bot s'arrête tout seul | `pm2 logs` pour voir l'erreur |
| DB perdue | Normale si le dossier `data/` a été supprimé — PM2 recrée au démarrage |
| SSH refusé | Vérifie ton mot de passe root dans le console Kamatera |
