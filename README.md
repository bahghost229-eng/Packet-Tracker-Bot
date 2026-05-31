# Packet Tracker Bot — Solana Dev Wallet Sniping

Bot Telegram Node.js pour surveiller la blockchain Solana en temps réel et détecter les transferts de fonds vers de nouveaux portefeuilles développeurs.

## Architecture

```
packet-tracker-bot/
├── src/
│   ├── index.js                  ← Point d'entrée, bootstrap
│   ├── engines/
│   │   ├── rpcSubscriber.js      ← WebSocket Solana (singleton, reconnexion auto)
│   │   ├── standardEngine.js     ← Mode Standard: filtre par range SOL
│   │   └── chainEngine.js        ← Mode Chain: suivi multi-hops dynamique
│   ├── handlers/
│   │   └── commands.js           ← Commandes Telegram (Telegraf)
│   ├── db/
│   │   └── database.js           ← SQLite via better-sqlite3
│   └── utils/
│       ├── solana.js             ← Helpers RPC, fresh wallet check
│       ├── formatter.js          ← Templates messages Telegram (MarkdownV2)
│       └── logger.js             ← Winston logger
├── data/
│   └── tracker.db                ← Base SQLite (auto-créée)
├── logs/                         ← Logs Winston + PM2
├── .env                          ← Variables d'environnement (à créer)
├── .env.example                  ← Template
├── ecosystem.config.js           ← Config PM2
└── package.json
```

## Installation

```bash
# Cloner / copier le projet
cd packet-tracker-bot

# Installer les dépendances
npm install

# Configurer l'environnement
cp .env.example .env
nano .env   # Remplir TELEGRAM_BOT_TOKEN, HELIUS_API_KEY, ALLOWED_USER_IDS
```

## Configuration `.env`

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token du bot (via @BotFather) |
| `HELIUS_API_KEY` | Clé API Helius (RPC Solana premium) |
| `HELIUS_RPC_HTTP` | URL RPC HTTP Helius |
| `HELIUS_RPC_WSS` | URL WSS Helius |
| `ALLOWED_USER_IDS` | IDs Telegram autorisés (virgule) |
| `CHAIN_HOP_TIMEOUT_MS` | Timeout par hop (défaut: 30000ms) |
| `WS_RECONNECT_DELAY_MS` | Délai reconnexion WSS (défaut: 3000ms) |

## Démarrage

```bash
# Direct Node.js
node src/index.js

# Avec PM2 (recommandé production/Debian)
npm install -g pm2
pm2 start ecosystem.config.js
pm2 logs packet-tracker
pm2 save && pm2 startup   # Autostart au reboot
```

## Commandes Telegram

| Commande | Description |
|----------|-------------|
| `/start` | Initialise et affiche le menu |
| `/add_standard <wallet> <min> <max> [label] [fresh_only]` | Mode standard |
| `/add_chain <wallet> <max_hops> [min] [max] [label] [fresh_only]` | Mode chain tracker |
| `/status` | Affiche toutes les stratégies |
| `/pause <id>` | Met en pause une stratégie |
| `/resume <id>` | Réactive une stratégie |
| `/delete <id>` | Supprime une stratégie |

### Exemples

```
# Surveiller un wallet pour des transferts entre 1.057 et 1.058 SOL, wallets fresh uniquement
/add_standard 7xKX...abc 1.057 1.058 "Dev Alpha" true

# Suivre une chaîne jusqu'à 3 hops depuis un mother wallet
/add_chain 9mPQ...xyz 3 0.5 2.0 "Mother Beta" true
```

## Format des alertes Telegram

### Standard Mode
```
🚨 ALERTE STANDARD — Dev Alpha
📤 From: 7xKX...abc
📥 To:   NEW_WALLET_ADDRESS
💰 Amount: 1.0570000 SOL
🔍 Fresh: 🟢 FRESH

🔗 Voir sur Solscan
⚡ Copy Trade Wallet: NEW_WALLET_ADDRESS
```

### Chain Tracker Mode
```
🔗 CHAIN TRACKER — Hop 2/3
📌 Mother Wallet: 9mPQ...xyz
🎯 Dev Wallet Final: DEV_WALLET_ADDRESS
💰 Amount: 0.9900000 SOL
🔍 Fresh: 🟢 FRESH

⚡ Copy Trade Wallet: DEV_WALLET_ADDRESS | Montant: 0.990000 SOL | Fresh: Oui
```

## Flux Chain Tracker

```
Mother Wallet ──[1.0 SOL]──► Wallet A
                               │ (Hop 1, timeout: 30s)
                               ▼
                             Wallet B
                               │ (Hop 2, timeout: 30s)
                               ▼
                        🎯 Dev Wallet Final
                           ► ALERTE TELEGRAM
```

## Notes de performance

- **p-limit**: Concurrence RPC limitée à 5 requêtes simultanées (Standard) / 3 (Chain)
- **Déduplication**: Chaque signature est vérifiée en DB avant parsing RPC
- **Anti-boucle**: Chaque ChainContext maintient un Set des wallets déjà visités
- **Reconnexion**: Backoff exponentiel plafonné à 60s
- **Timeout hop**: Configurable via `CHAIN_HOP_TIMEOUT_MS` (défaut: 30s)
