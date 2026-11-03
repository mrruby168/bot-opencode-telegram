import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '..', '.env') });

import { Bot } from 'grammy';
import { loadConfig } from './config.js';
import { logLine, maskSecrets, senderId } from './common.js';
import { createBotHandlers } from './router.js';

const config = loadConfig(process.env);
const handlers = createBotHandlers({ config });

const bot = new Bot(config.telegramBotToken);

// Whitelist cho cả message và callback_query. Người lạ: im lặng, chỉ log ID.
bot.use(async (ctx, next) => {
  const id = senderId(ctx);
  if (!config.allowedUsers.has(id)) {
    logLine('WARN', `stranger blocked id=${String(id)}`);
    return;
  }
  await next();
});

handlers.register(bot);

const COMMANDS = [
  { command: 'start', description: 'Mở menu bot' },
  { command: 'web', description: 'Link web OpenCode (WiFi)' },
  { command: 'shot', description: 'Chụp màn hình PC' },
  { command: 'cancel_shutdown', description: 'Hủy lệnh tắt máy' },
  { command: 'status', description: 'Trạng thái bot + CLI V2' }
];

try {
  await bot.api.setMyCommands(COMMANDS);
} catch (e) {
  logLine('WARN', `setMyCommands failed: ${maskSecrets(e?.message ?? e)}`);
}
try {
  await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
} catch (e) {
  logLine('WARN', `setChatMenuButton failed: ${maskSecrets(e?.message ?? e)}`);
}

bot.catch((err) => {
  logLine('ERROR', `bot.catch ${maskSecrets(err?.message ?? err).slice(0, 300)}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logLine('INFO', `received ${signal}, stopping bot`);
  try {
    await bot.stop();
  } catch { /* bỏ qua */ }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => {
  logLine('ERROR', `unhandledRejection ${maskSecrets(e?.message ?? e).slice(0, 300)}`);
});
process.on('uncaughtException', (e) => {
  logLine('ERROR', `uncaughtException ${maskSecrets(e?.message ?? e).slice(0, 300)}`);
  process.exit(1);
});

await bot.start({
  drop_pending_updates: true,
  onStart: (info) => logLine('INFO', `tele-commander started @${info.username}`)
});
