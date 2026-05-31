# Task — Features manquantes Packet Tracker Bot

## Features à implémenter
1. [x] Standard Mode
2. [x] Chain Tracker
3. [x] Fresh/Non-Fresh filter
4. [ ] /backtest <wallet> <signature> — Simule la chaîne et affiche le wallet final
5. [ ] /exchanges — Répertoire des wallets exchanges (CRUD)
6. [ ] /my_strategy — Journal de trading (wallet + range + description)
7. [ ] Multi-range même wallet — Permettre plusieurs stratégies sur le même wallet
8. [ ] Export CSV des scans détectés
9. [ ] Intégration TradeWiz — Envoyer message Telegram formaté vers TradeWiz bot

## Fichiers à modifier/créer
- src/db/database.js       → nouvelles tables: exchanges, user_strategies
- src/handlers/commands.js → nouvelles commandes
- src/utils/backtest.js    → NEW: logique de simulation de chaîne
- src/utils/csv.js         → NEW: export CSV
- src/utils/tradewiz.js    → NEW: intégration TradeWiz
- src/handlers/exchanges.js → NEW: CRUD exchanges
- src/handlers/mystrategies.js → NEW: journal

## Status
- [ ] En cours
