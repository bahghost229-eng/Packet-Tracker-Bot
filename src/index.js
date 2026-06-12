/**
 * index.js — Point d'entrée principal
 * ─────────────────────────────────────────────────────────────────────────────
 * Initialise:
 *   1. Variables d'environnement (.env)
 *   2. Base de données SQLite
 *   3. Bot Telegram (Telegraf)
 *   4. Subscriber WebSocket Solana
 *   5. Moteurs Standard & Chain Tracker
 *   6. Gestion gracieuse des signaux OS (SIGTERM, SIGINT)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const { Telegraf, Scenes, session } = require('telegraf');
const logger               = require('./utils/logger');
const { initDB,
        getActiveStrategies } = require('./db/database');
const rpcSubscriber        = require('./engines/rpcSubscriber');
const heliusWebhook        = require('./utils/heliusWebhook');
const StandardEngine       = require('./engines/standardEngine');
const ChainEngine          = require('./engines/chainEngine');
const { registerCommands } = require('./handlers/commands');
const { addStandardWizard, addChainWizard } = require('./handlers/scenes');

// ─────────────────────────────────────────────────────────────────────────────
// Validation de l'environnement
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'HELIUS_API_KEY', 'HELIUS_RPC_HTTP'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    logger.error(`❌ Variable d'environnement manquante: ${key}`);
    logger.error('   → Copie .env.example en .env et remplis toutes les valeurs');
    process.exit(1);
  }
}

// Vérifie que la clé API est bien injectée dans les URLs
const HTTP_URL = process.env.HELIUS_RPC_HTTP;
const WSS_URL  = process.env.HELIUS_RPC_WSS;
const KEY      = process.env.HELIUS_API_KEY;

if (!HTTP_URL.includes(KEY) && !HTTP_URL.includes('api-key')) {
  logger.warn('⚠️  HELIUS_API_KEY absente de HELIUS_RPC_HTTP — elle sera injectée automatiquement');
}
if (!WSS_URL.includes(KEY) && !WSS_URL.includes('api-key')) {
  logger.warn('⚠️  HELIUS_API_KEY absente de HELIUS_RPC_WSS — elle sera injectée automatiquement');
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialisation
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  logger.info('🚀 Démarrage Packet Tracker Bot...');

  // 1. DB
  initDB();
  logger.info('[Boot] ✅ Base de données initialisée');

  // 2. Bot Telegram
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  // 3. Moteurs (instances uniques, partagées)
  const standardEngine = new StandardEngine(bot);
  const chainEngine    = new ChainEngine(bot);

  /**
   * Redémarre les moteurs de détection.
   * Appelé après chaque ajout/suppression/pause de stratégie.
   */
  async function restartEngines() {
    logger.info('[Boot] Redémarrage des moteurs...');
    standardEngine.stop();
    chainEngine.stop();

    const strategies = getActiveStrategies();
    logger.info(`[Boot] ${strategies.length} stratégie(s) active(s) chargées`);

    standardEngine.start(strategies);
    chainEngine.start(strategies);
  }

  // 4. Test de connectivité RPC avant de démarrer le subscriber
  logger.info('[Boot] Test de connectivité RPC...');
  try {
    const { getConnection } = require('./utils/solana');
    const slot = await getConnection().getSlot('finalized');
    logger.info(`[Boot] ✅ RPC opérationnel — slot: ${slot}`);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('401') || msg.includes('403')) {
      logger.error(
        '❌ ERREUR 401 — Clé API Helius invalide.\n' +
        '   Vérifie HELIUS_API_KEY dans ton .env\n' +
        '   Dashboard: https://dev.helius.xyz/dashboard'
      );
      process.exit(1);
    }
    logger.warn(`[Boot] ⚠️ RPC non disponible au démarrage (${msg}) — le bot va quand même démarrer`);
  }

  // 5. Init webhook Helius (crée ou retrouve le webhook)
  await heliusWebhook.init();

  // 6. Démarrage du serveur webhook + subscriber
  await rpcSubscriber.start();
  logger.info('[Boot] ✅ Webhook Helius prêt (HTTP POST /webhook)');

  // 7. Scenes (wizards) — doivent être avant les commandes
  const stage = new Scenes.Stage([addStandardWizard, addChainWizard]);
  // Injecte restartEngines dans le state de chaque scene
  addStandardWizard.use((ctx, next) => {
    ctx.scene.state.onCreate = () => restartEngines();
    return next();
  });
  addChainWizard.use((ctx, next) => {
    ctx.scene.state.onCreate = () => restartEngines();
    return next();
  });
  bot.use(session());
  bot.use(stage.middleware());

  // 8. Commandes Telegram
  registerCommands(bot, restartEngines, stage);

  // 9. Démarrage initial des moteurs
  await restartEngines();

  // 8. Lancement du bot (long polling)
  logger.info('[Boot] Tentative bot.launch()...');

  // Garde le process en vie même si bot.launch() resolve tôt
  let botStopped = false;
  bot.launch({
    allowedUpdates: ['message', 'callback_query'],
  }).then(() => {
    if (!botStopped) {
      logger.warn('[Boot] bot.launch() a terminé de manière inattendue — redémarrage...');
      process.exit(1);
    }
  }).catch((err) => {
    logger.error(`[Boot] ❌ bot.launch() ÉCHEC: ${err.message}`);
    if (err.message.includes('409')) {
      logger.error('[Boot] → 409 Conflict: une autre instance tourne déjà.');
      logger.error('[Boot] → Tue tous les process node: pkill -f "node src/index"');
    } else if (err.message.includes('401')) {
      logger.error('[Boot] → 401 Unauthorized: token invalide dans .env');
    }
    process.exit(1);
  });

  // Attends que le bot soit vraiment prêt (getMe confirme la connexion)
  await bot.telegram.getMe().catch((err) => {
    logger.error(`[Boot] ❌ getMe() ÉCHEC: ${err.message}`);
    process.exit(1);
  });

  logger.info('[Boot] ✅ Bot Telegram actif (long polling)');

  // ── Notification de démarrage aux admins ───────────────────────────────

  const adminIds = (process.env.ALLOWED_USER_IDS || '').split(',').filter(Boolean);
  const strategies = getActiveStrategies();
  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(
        adminId.trim(),
        `✅ *Packet Tracker Bot démarré*\n` +
        `📡 ${strategies.length} stratégie(s) active(s)\n` +
        `🕐 ${new Date().toUTCString()}`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  }

  // ── Gestion des signaux OS ─────────────────────────────────────────────

  async function shutdown(signal) {
    botStopped = true;
    logger.info(`[Shutdown] Signal ${signal} reçu — arrêt propre...`);
    standardEngine.stop();
    chainEngine.stop();
    await rpcSubscriber.stop();
    bot.stop(signal);
    logger.info('[Shutdown] Arrêt terminé.');
    process.exit(0);
  }

  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Capture des rejets non gérés pour éviter les crashes silencieux
  process.on('unhandledRejection', (reason) => {
    logger.error(`[UnhandledRejection] ${reason}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`[UncaughtException] ${err.message}\n${err.stack}`);
  });
}

main().catch((err) => {
  logger.error(`[main] Erreur fatale: ${err.message}\n${err.stack}`);
  process.exit(1);
});
