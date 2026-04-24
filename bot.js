/**
 * bot.js
 * Money Coach v2 — Telegram bot runner
 * Run: node bot.js
 */

import { registerCommands } from './bot-commands.js';
import TelegramBot from 'node-telegram-bot-api';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
registerCommands(bot);

bot.on('polling_error', (err) => {
  console.error('[bot] Polling error:', err.message);
});

console.log('Telegram bot started — Money Coach v2');
