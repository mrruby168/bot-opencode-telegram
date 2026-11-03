// Tính năng "Link Web (WiFi)": gọi opencode-cli V2 của Desktop để lấy link pair,
// mở web UI OpenCode trên điện thoại CÙNG session với PC.
// Không spawn server riêng. Link pair = credential: KHÔNG log, KHÔNG lưu state.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InlineKeyboard } from 'grammy';
import { isAllowed, logLine, maskSecrets, senderId } from './common.js';

const W = path.win32; // đường dẫn Windows, cố định để test chạy được trên mọi OS

export const SERVICE_PORT_DEFAULT = 28894;
export const STATUS_TIMEOUT_MS = 15000;
export const SERVICE_CMD_TIMEOUT_MS = 30000;
export const POLL_MAX = 20;
export const POLL_INTERVAL_MS = 1000;
export const PENDING_TTL_MS = 5 * 60 * 1000;

const FIREWALL_RULE = 'OpenCode';
const CLI_EXE = 'opencode-cli.exe';
const VERSION_DIR_RE = /^\d+\.\d+\.\d+-/;
const LINK_RE = /https?:\/\/\S+\/auth\/connect\/\S+/;
const URL_RE = /https?:\/\/[^\s"'<>]+/;
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SKIP_NIC_RE = /vethernet|hyper-v|virtualbox|vbox|vmware|vmnet|vpn|tap-|tailscale|zerotier|hamachi|wireguard|wsl|docker|bluetooth|loopback/i;

const MSG_CLI_MISSING = 'Chưa tìm thấy opencode-cli V2. Điền OPENCODE_V2_CLI trong .env hoặc kiểm tra Desktop đã cài chưa.';
const msgCliNotFound = (p) => `Không thấy file: ${p}. Desktop update thì sửa OPENCODE_V2_CLI.`;

export function firewallManualCmd(port) {
  return `New-NetFirewallRule -DisplayName "${FIREWALL_RULE}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow`;
}

// ---- Hàm thuần (dễ test) ----

// Che token trong link pair + các mẫu secret chung trước khi gửi/ghi log.
export function redact(text) {
  return maskSecrets(String(text ?? '').replace(/(\/auth\/connect\/)\S+/gi, '$1[ẨN]'));
}

function stripAnsi(s) {
  return String(s ?? '').replace(ANSI_RE, '');
}

export function parsePairLink(out) {
  const m = LINK_RE.exec(stripAnsi(out));
  return m ? m[0] : null;
}

// "http://127.0.0.1:28894" -> { host, port, url }; không có URL hợp lệ -> null.
export function parseServiceStatus(out) {
  const m = URL_RE.exec(stripAnsi(out));
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    return { host: u.hostname, port: Number(u.port) || SERVICE_PORT_DEFAULT, url: u.origin };
  } catch {
    return null; // URL hỏng được xử lý như "không in URL" => DOWN
  }
}

export function isLocalHost(host) {
  return LOCAL_HOSTS.has(String(host));
}

export function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// B1: .env > tự dò %APPDATA%\ai.opencode.desktop\cli\<ver>-*\opencode-cli.exe (version lớn nhất).
// Trả { status: 'ok'|'missing'|'not-found', path? }.
export function locateCli({
  configured = null,
  env = process.env,
  existsFn = fs.existsSync,
  readdirFn = (d) => fs.readdirSync(d)
} = {}) {
  if (configured) {
    return existsFn(configured) ? { path: configured, status: 'ok' } : { path: configured, status: 'not-found' };
  }
  if (!env.APPDATA) return { status: 'missing' };
  const base = W.join(env.APPDATA, 'ai.opencode.desktop', 'cli');
  let names;
  try {
    names = readdirFn(base);
  } catch {
    return { status: 'missing' }; // không có thư mục Desktop: báo "thiếu" rõ ràng ở caller
  }
  const versions = names.filter((n) => VERSION_DIR_RE.test(n)).sort((a, b) => compareVersions(b, a));
  if (versions.length === 0) return { status: 'missing' };
  const file = W.join(base, versions[0], CLI_EXE);
  return existsFn(file) ? { path: file, status: 'ok' } : { path: file, status: 'not-found' };
}

export function cliErrorMessage(loc) {
  if (loc.status === 'missing') return MSG_CLI_MISSING;
  if (loc.status === 'not-found') return msgCliNotFound(loc.path);
  return '';
}

// B5: IPv4 LAN, bỏ loopback/APIPA, tránh card ảo/VPN; ưu tiên 192.168 > 10 > 172.16-31.
export function pickLanIp(ifaces) {
  const all = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || !a.address || a.address.startsWith('169.254.')) continue;
      all.push({ ip: a.address, name });
    }
  }
  const rank = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    const m = /^172\.(\d+)\./.exec(ip);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2;
    return 3;
  };
  const real = all.filter((c) => !SKIP_NIC_RE.test(c.name));
  const pool = real.length > 0 ? real : all;
  pool.sort((x, y) => rank(x.ip) - rank(y.ip));
  return pool[0]?.ip ?? null;
}

function defaultExecFn(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      let out = String(stdout ?? '') + String(stderr ?? '');
      if (err && !out) out = String(err.message ?? err);
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out, timedOut: !!(err && err.killed) });
    });
  });
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (out, n = 300) => redact(String(out ?? '').trim()).slice(-n);

function stepError(what, out = '') {
  const t = tail(out);
  return new Error(t ? `${what}\n${t}` : what);
}

export function createWebLinkService({
  config,
  execFn = defaultExecFn,
  existsFn = fs.existsSync,
  readdirFn = (d) => fs.readdirSync(d),
  env = process.env,
  netFn = os.networkInterfaces,
  sleepFn = defaultSleep,
  nowFn = () => Date.now()
}) {
  const pending = new Map(); // userId -> { nonce, step, expiresAt }
  const busy = new Set(); // userId đang chạy flow

  const locate = () => locateCli({ configured: config.v2CliPath, env, existsFn, readdirFn });
  const NETSH = W.join(env.SystemRoot || 'C:\\Windows', 'System32', 'netsh.exe');

  function cliStatus() {
    return { missing: 'thiếu', 'not-found': 'không tồn tại', ok: 'OK' }[locate().status];
  }

  // B2: DOWN khi lệnh lỗi/timeout hoặc không in URL.
  async function serviceStatus(cli) {
    const r = await execFn(cli, ['service', 'status'], STATUS_TIMEOUT_MS);
    const info = r.code === 0 && !r.timedOut ? parseServiceStatus(r.out) : null;
    return info ? { up: true, ...info } : { detail: r.out, up: false };
  }

  async function waitUp(cli, { wantLan = false } = {}) {
    let last = { detail: '', up: false };
    for (let i = 0; i < POLL_MAX; i++) {
      last = await serviceStatus(cli);
      if (last.up && (!wantLan || !isLocalHost(last.host))) return last;
      await sleepFn(POLL_INTERVAL_MS);
    }
    return last;
  }

  async function startService(cli) {
    const r = await execFn(cli, ['service', 'start'], SERVICE_CMD_TIMEOUT_MS);
    const up = await waitUp(cli);
    if (!up.up) throw stepError(`Bật service lỗi (mã ${r.code}). Thử mở lại OpenCode Desktop.`, r.out || up.detail);
    return up;
  }

  // B3: đổi hostname 0.0.0.0 rồi restart service.
  async function exposeOnLan(cli) {
    const set = await execFn(cli, ['service', 'set', 'hostname', '0.0.0.0'], SERVICE_CMD_TIMEOUT_MS);
    if (set.code !== 0) throw stepError(`Đặt hostname 0.0.0.0 lỗi (mã ${set.code}).`, set.out);
    const start = await execFn(cli, ['service', 'start'], SERVICE_CMD_TIMEOUT_MS);
    if (start.code !== 0) throw stepError(`Restart service lỗi (mã ${start.code}).`, start.out);
    const up = await waitUp(cli, { wantLan: true });
    if (!up.up) throw stepError('Service không lên lại sau restart. Mở lại OpenCode Desktop rồi bấm lại.', up.detail);
    if (isLocalHost(up.host)) throw new Error('Service vẫn nghe ở 127.0.0.1 sau khi đặt hostname. Kiểm tra OpenCode Desktop rồi bấm lại.');
    return up;
  }

  // B4: kiểm tra/thêm rule firewall. Lỗi quyền không chặn luồng.
  async function ensureFirewall(port) {
    const chk = await execFn(NETSH, ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE}`], SERVICE_CMD_TIMEOUT_MS);
    if (chk.code === 0 && /OpenCode/i.test(chk.out)) return { ok: true };
    const add = await execFn(
      NETSH,
      ['advfirewall', 'firewall', 'add', 'rule', `name=${FIREWALL_RULE}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`],
      SERVICE_CMD_TIMEOUT_MS
    );
    return add.code === 0 ? { ok: true } : { manual: firewallManualCmd(port), ok: false };
  }

  function lanIp() {
    if (config.lanIp) return config.lanIp;
    const ip = pickLanIp(netFn());
    if (!ip) throw new Error('Không xác định được IP LAN, điền WEB_LAN_IP trong .env.');
    return ip;
  }

  // B6
  async function requestLink(cli, ip, port) {
    const r = await execFn(cli, ['pair', '--url', `http://${ip}:${port}`], config.pairTimeoutMs);
    if (r.timedOut) {
      throw new Error(`Lấy link quá ${Math.round(config.pairTimeoutMs / 1000)}s, đã dừng tiến trình pair. Thử lại hoặc tăng PAIR_TIMEOUT_MS.`);
    }
    const link = parsePairLink(r.out);
    if (!link) {
      throw new Error(`Không tìm thấy link trong kết quả pair (mã ${r.code}). Đầu ra: ${redact(r.out).slice(0, 300)}`);
    }
    return link;
  }

  async function clearButtons(ctx) {
    const m = ctx.callbackQuery?.message;
    if (!m) return;
    try {
      await ctx.api.editMessageReplyMarkup(m.chat.id, m.message_id, {});
    } catch (e) {
      logLine('WARN', `weblink clear buttons failed: ${redact(e?.message ?? e).slice(0, 120)}`);
    }
  }

  async function ask(ctx, userId, step, text, yesLabel, noLabel) {
    const nonce = randomBytes(8).toString('hex');
    pending.set(userId, { expiresAt: nowFn() + PENDING_TTL_MS, nonce, step });
    const [yes, no] = step === 'start' ? ['start', 'skip'] : ['go', 'cancel'];
    await ctx.reply(text, {
      reply_markup: new InlineKeyboard().text(yesLabel, `web:${yes}:${nonce}`).text(noLabel, `web:${no}:${nonce}`)
    });
  }

  // B4 + B5 + B6 + B7
  async function deliver(ctx, cli, st) {
    const fw = await ensureFirewall(st.port);
    if (!fw.ok) {
      await ctx.reply(
        `Chưa mở được firewall (cần quyền Admin). Nếu điện thoại không mở được link, chạy 1 dòng trong PowerShell (Admin):\n${fw.manual}`
      );
    }
    const ip = lanIp();
    const link = await requestLink(cli, ip, st.port);
    // Gửi trực tiếp ctx.reply (không qua replyChunked/log): link là credential.
    await ctx.reply(
      `Link mở OpenCode trên điện thoại (cùng WiFi):\n${link}\n\n` +
      '• Dùng 1 lần, hết hạn sau 5 phút\n' +
      '• Mở xong giữ đăng nhập 30 ngày\n' +
      '• Chỉ dùng trong WiFi nhà, KHÔNG dùng được 4G\n' +
      '• Đổi máy / hết hạn: bấm lại nút này'
    );
    logLine('INFO', `pair ok ip=${ip} port=${st.port}`);
  }

  async function afterUp(ctx, userId, cli, st) {
    if (isLocalHost(st.host)) {
      await ask(ctx, userId, 'lan', 'Sẽ restart OpenCode service, Desktop sẽ ngắt kết nối vài giây. Tiếp tục?', 'Tiếp tục', 'Huỷ');
      return;
    }
    await deliver(ctx, cli, st);
  }

  async function guarded(ctx, userId, fn) {
    busy.add(userId);
    try {
      await fn();
    } catch (e) {
      const msg = redact(e?.message ?? e);
      logLine('ERROR', `weblink fail ${msg.slice(0, 200)}`);
      await ctx.reply(msg.slice(0, 1500));
    } finally {
      busy.delete(userId);
    }
  }

  // Nút menu / lệnh /web.
  async function handleLink(ctx, allowedUsers) {
    if (!isAllowed(ctx, allowedUsers)) return false; // im lặng
    const userId = senderId(ctx);
    try { await ctx.answerCallbackQuery?.(); } catch (e) { logLine('WARN', `answerCb failed: ${redact(e?.message ?? e).slice(0, 80)}`); }
    if (busy.has(userId)) {
      await ctx.reply('Đang xử lý yêu cầu trước, đợi chút.');
      return true;
    }
    await guarded(ctx, userId, async () => {
      const loc = locate();
      if (loc.status !== 'ok') {
        await ctx.reply(cliErrorMessage(loc));
        return;
      }
      const st = await serviceStatus(loc.path);
      if (!st.up) {
        await ask(ctx, userId, 'start', 'Opencode service chưa chạy. Bật lại?', 'Bật lại', 'Không');
        return;
      }
      await afterUp(ctx, userId, loc.path, st);
    });
    return true;
  }

  // Callback web:<action>:<nonce>
  async function handleCallback(ctx, allowedUsers) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('web:')) return false;
    try { await ctx.answerCallbackQuery?.(); } catch (e) { logLine('WARN', `answerCb failed: ${redact(e?.message ?? e).slice(0, 80)}`); }
    if (!isAllowed(ctx, allowedUsers)) return true;
    const userId = senderId(ctx);
    const [, action, nonce] = data.split(':');
    // Claim ĐỒNG BỘ trước mọi await (chống bấm 2 lần).
    const p = pending.get(userId);
    if (!p || p.nonce !== nonce || nowFn() > p.expiresAt) {
      await ctx.reply('Yêu cầu đã hết hạn, bấm lại "Link Web (WiFi)".');
      return true;
    }
    pending.delete(userId);
    await clearButtons(ctx);
    const valid = p.step === 'start' ? ['start', 'skip'] : ['go', 'cancel'];
    if (!valid.includes(action)) {
      await ctx.reply('Lựa chọn không hợp lệ.');
      return true;
    }
    if (action === 'skip') {
      await ctx.reply('Đã bỏ qua.');
      return true;
    }
    if (action === 'cancel') {
      await ctx.reply('Đã huỷ, service giữ nguyên.');
      return true;
    }
    await guarded(ctx, userId, async () => {
      const loc = locate();
      if (loc.status !== 'ok') {
        await ctx.reply(cliErrorMessage(loc));
        return;
      }
      if (action === 'start') {
        await ctx.reply('Đang bật OpenCode service…');
        const st = await startService(loc.path);
        await afterUp(ctx, userId, loc.path, st);
        return;
      }
      await ctx.reply('Đang restart OpenCode service…');
      const st = await exposeOnLan(loc.path);
      await deliver(ctx, loc.path, st);
    });
    return true;
  }

  return { cliStatus, handleCallback, handleLink };
}
