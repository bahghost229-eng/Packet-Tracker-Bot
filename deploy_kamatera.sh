#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy_kamatera.sh
# Déploie Packet Tracker Bot sur ton serveur Kamatera via SSH
# Usage: bash deploy_kamatera.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

SERVER_IP="199.19.73.16"
SERVER_USER="root"
REPO_URL="https://github.com/bahghost229-eng/Packet-Tracker-Bot.git"
APP_DIR="/opt/packet-tracker-bot"
NODE_VERSION="20"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Packet Tracker Bot — Deploy Kamatera  "
echo "  Serveur: $SERVER_IP                   "
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "▶ Connexion SSH à $SERVER_USER@$SERVER_IP..."
echo "  (Tu vas entrer ton mot de passe root)"
echo ""

ssh -o StrictHostKeyChecking=no "$SERVER_USER@$SERVER_IP" bash <<EOF
set -e

echo "━━━ [1/6] Mise à jour système ━━━"
apt-get update -qq && apt-get upgrade -y -qq

echo "━━━ [2/6] Installation Node.js $NODE_VERSION + npm ━━━"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
fi
echo "Node: \$(node -v) | npm: \$(npm -v)"

echo "━━━ [3/6] Installation PM2 ━━━"
npm install -g pm2 --quiet

echo "━━━ [4/6] Clone / update repo ━━━"
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR"
  git pull origin main
  echo "Repo mis à jour"
else
  git clone "$REPO_URL" "$APP_DIR"
  echo "Repo cloné"
fi

cd "$APP_DIR"
npm ci --omit=dev --quiet

echo "━━━ [5/6] Dossiers data + logs ━━━"
mkdir -p data logs
chmod 700 data

echo "━━━ [6/6] Vérification .env ━━━"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "⚠️  ATTENTION: .env manquant!"
  echo "   Copie .env.example et remplis les variables:"
  echo "   cp $APP_DIR/.env.example $APP_DIR/.env"
  echo "   nano $APP_DIR/.env"
else
  echo "✅ .env présent"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Installation terminée!"
echo "  Prochaine étape: configurer .env puis:"
echo "  cd $APP_DIR && pm2 start src/index.js --name packet-tracker"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
EOF
