import { isAllowed, logLine, maskSecrets, replyChunked, senderId } from './common.js';
import { createPowerController } from './power.js';
import { sendMainMenu } from './menu.js';
import { createScreenshotService } from './screenshot.js';
import { createWebLinkService } from './weblink.js';

const COMMANDS_HINT = 'Lệnh hỗ trợ: /start, /web, /shot, /cancel_shutdown, /status.';

export function createBotHandlers({ config, power = null, screenshot = null, webLink = null }) {
  const powerCtl = power || createPowerController({ onMenu: (ctx) => sendMainMenu(ctx) });
  const shotSvc = screenshot || createScreenshotService();
  const web = webLink || createWebLinkService({ config });

  async function answerCb(ctx) {
    try {
      await ctx.answerCallbackQuery();
    } catch (e) {
      logLine('WARN', `answerCallbackQuery failed: ${maskSecrets(e?.message ?? e).slice(0, 120)}`);
    }
  }

  async function handleGoCallback(ctx) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('go:')) return false;
    await answerCb(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return true;
    const [, what, arg] = data.split(':');
    if (what === 'menu') {
      await sendMainMenu(ctx);
    } else if (what === 'pc' && arg === 'now') {
      await powerCtl.cmdShutdownNow(ctx);
    } else if (what === 'pc' && arg === 'shot') {
      await shotSvc.handleScreenshot(ctx, config.allowedUsers);
    } else if (what === 'web' && arg === 'link') {
      await web.handleLink(ctx, config.allowedUsers);
    } else {
      await sendMainMenu(ctx);
    }
    return true;
  }

  // Mọi text không phải lệnh: hiện menu. Text dạng lệnh lạ: nhắc lệnh hợp lệ.
  async function handleText(ctx) {
    if (!isAllowed(ctx, config.allowedUsers)) return; // im lặng
    const text = ctx.message?.text ?? '';
    if (text.trim().startsWith('/')) await ctx.reply(COMMANDS_HINT);
    await sendMainMenu(ctx);
  }

  async function handleStart(ctx) {
    if (!isAllowed(ctx, config.allowedUsers)) return;
    await sendMainMenu(ctx);
  }

  async function handleStatus(ctx) {
    if (!isAllowed(ctx, config.allowedUsers)) return;
    await replyChunked(ctx, `Bot: online\nCLI V2: ${web.cliStatus()}`);
  }

  const guard = (fn) => (ctx) => {
    if (!isAllowed(ctx, config.allowedUsers)) return;
    void fn(ctx).catch((e) => logLine('ERROR', maskSecrets(e?.message ?? e).slice(0, 120)));
  };

  function register(bot) {
    bot.command('start', guard(handleStart));
    bot.command('status', guard(handleStatus));
    bot.command('web', guard((ctx) => web.handleLink(ctx, config.allowedUsers)));
    bot.command('shot', guard((ctx) => shotSvc.handleScreenshot(ctx, config.allowedUsers)));
    bot.command('cancel_shutdown', guard((ctx) => powerCtl.cmdCancelShutdown(ctx)));
    bot.on('message:text', (ctx) => void handleText(ctx).catch((e) => logLine('ERROR', maskSecrets(e?.message ?? e).slice(0, 120))));
    bot.on('callback_query:data', (ctx) => {
      void (async () => {
        if (await powerCtl.handlePowerCallback(ctx, config.allowedUsers)) return;
        if (await shotSvc.handleFileCallback(ctx, config.allowedUsers)) return;
        if (await web.handleCallback(ctx, config.allowedUsers)) return;
        if (await handleGoCallback(ctx)) return;
        await answerCb(ctx);
      })().catch((e) => logLine('ERROR', maskSecrets(e?.message ?? e).slice(0, 120)));
    });
  }

  return { handleGoCallback, handleStart, handleStatus, handleText, register };
}
