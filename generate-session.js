/**
 * generate-session.js
 * Lance une connexion MTProto interactive pour générer une session string.
 * Exécute: node generate-session.js
 * Copie la SESSION_STRING affichée dans ton .env sur Kamatera.
 */

'use strict';

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const readline           = require('readline');
require('dotenv').config({ path: '.env.mtproto' });

const API_ID   = parseInt(process.env.TELEGRAM_API_ID,   10);
const API_HASH = process.env.TELEGRAM_API_HASH;

if (!API_ID || !API_HASH) {
  console.error('❌ TELEGRAM_API_ID ou TELEGRAM_API_HASH manquant dans .env.mtproto');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

(async () => {
  console.log('\n🔐 Génération de la session Telegram MTProto\n');

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber:  async () => ask('📱 Ton numéro Telegram (ex: +221771234567): '),
    password:     async () => ask('🔑 Mot de passe 2FA (si activé, sinon Entrée): '),
    phoneCode:    async () => ask('📩 Code reçu par SMS/Telegram: '),
    onError:      (err)    => console.error('Erreur:', err),
  });

  const sessionString = client.session.save();

  console.log('\n✅ Session générée avec succès!\n');
  console.log('══════════════════════════════════════════════════');
  console.log('SESSION_STRING=' + sessionString);
  console.log('══════════════════════════════════════════════════');
  console.log('\n📋 Copie cette ligne dans ton .env sur Kamatera.\n');

  await client.disconnect();
  rl.close();
  process.exit(0);
})();
