/**
 * ecosystem.config.js — Configuration PM2
 * Usage: pm2 start ecosystem.config.js
 */
module.exports = {
  apps: [
    {
      name:             'packet-tracker',
      script:           './src/index.js',
      interpreter:      'node',
      instances:        1,               // 1 seule instance (WebSocket stateful)
      autorestart:      true,
      watch:            false,
      max_restarts:     20,
      restart_delay:    3000,
      exp_backoff_restart_delay: 100,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format:  'YYYY-MM-DD HH:mm:ss',
      error_file:       './logs/pm2-error.log',
      out_file:         './logs/pm2-out.log',
      merge_logs:       true,
    },
  ],
};
