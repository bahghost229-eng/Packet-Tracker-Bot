/**
 * logger.js
 * Winston logger centralisé avec rotation quotidienne (fichiers + console).
 */

'use strict';

const { createLogger, format, transports } = require('winston');
const fs = require('fs');

fs.mkdirSync('./logs', { recursive: true });

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      return stack
        ? `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`
        : `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
    new transports.File({ filename: './logs/error.log', level: 'error' }),
    new transports.File({ filename: './logs/combined.log' }),
  ],
  exceptionHandlers: [
    new transports.File({ filename: './logs/exceptions.log' }),
  ],
});

module.exports = logger;
