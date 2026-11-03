import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWebLinkService,
  firewallManualCmd,
  locateCli,
  parsePairLink,
  parseServiceStatus,
  pickLanIp,
  redact
} from '../src/weblink.js';

const USER = 7;
const ALLOWED = new Set([USER]);
const CLI = 'C:\\fake\\opencode-cli.exe';
const TOKEN = 'SECRETTOKEN123abcXYZ';
const LINK = `http://192.168.1.50:28894/auth/connect/${TOKEN}`;
const PAIR_OUT = `Open a link to connect. Links work once and expire in 5 minutes.\n${LINK}\n██ QR ██\n`;

let tmp;
let oldEnv;
beforeEach(() => {
  oldEnv = process.env.TELE_LOG_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-web-'));
  process.env.TELE_LOG_DIR = tmp;
});
afterEach(() => {
  if (oldEnv === undefined) delete process.env.TELE_LOG_DIR;
  else process.env.TELE_LOG_DIR = oldEnv;
  fs.rmSync(tmp, { force: true, recursive: true });
});

function allFilesText() {
  return fs.readdirSync(tmp).map((f) => fs.readFileSync(path.join(tmp, f), 'utf8')).join('\n');
}

function fakeCtx({ userId = USER, data = null } = {}) {
  const replies = [];
  const ctx = {
    api: { editMessageReplyMarkup: async () => {} },
    answerCallbackQuery: async () => {},
    from: { id: userId },
    replies,
    reply: async (text, opts) => { replies.push({ opts, text }); return { chat: { id: 1 }, message_id: replies.length }; }
  };
  if (data) ctx.callbackQuery = { data, from: { id: userId }, message: { chat: { id: 1 }, message_id: 1 } };
  return ctx;
}

// Exec giả: script theo "subcommand" (status/start/set/pair/netsh-show/netsh-add).
function makeExec(script = {}) {
  const calls = [];
  const execFn = async (file, args, timeoutMs) => {
    calls.push({ args, file, timeoutMs });
    let key;
    if (file.toLowerCase().endsWith('netsh.exe')) key = args[2] === 'show' ? 'fw-show' : 'fw-add';
    else key = args[0] === 'service' ? `service-${args[1]}` : args[0];
    const v = script[key];
    const r = typeof v === 'function' ? v(calls.length) : v;
    return r || { code: 0, out: '' };
  };
  return { calls, execFn };
}

function makeService({ script, config = {}, netFn = () => ({}) } = {}) {
  const { calls, execFn } = makeExec(script);
  const svc = createWebLinkService({
    config: { lanIp: '192.168.1.50', pairTimeoutMs: 60000, v2CliPath: CLI, ...config },
    env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', SystemRoot: 'C:\\Windows' },
    execFn,
    existsFn: () => true,
    netFn,
    sleepFn: async () => {}
  });
  return { calls, svc };
}

const UP_LAN = { code: 0, out: 'http://0.0.0.0:28894\n' };
const UP_LOCAL = { code: 0, out: 'http://127.0.0.1:28894\n' };
const sub = (calls, name) => calls.filter((c) => c.args[0] === name || (c.args[0] === 'service' && c.args[1] === name));

describe('parse', () => {
  it('parsePairLink: lấy link, bỏ QR/ANSI; không có link -> null', () => {
    assert.equal(parsePairLink(PAIR_OUT), LINK);
    assert.equal(parsePairLink(`\u001b[32m${LINK}\u001b[0m\nQR`), LINK);
    assert.equal(parsePairLink('Error: no pairing available'), null);
    assert.equal(parsePairLink('http://x/other/path'), null);
  });

  it('parseServiceStatus: URL -> host/port; rác -> null', () => {
    assert.deepEqual(parseServiceStatus('http://127.0.0.1:28894\n'), { host: '127.0.0.1', port: 28894, url: 'http://127.0.0.1:28894' });
    assert.equal(parseServiceStatus('http://0.0.0.0:3000').port, 3000);
    assert.equal(parseServiceStatus('service stopped'), null);
  });

  it('redact che token link', () => {
    const t = redact(`lỗi ${LINK} và /auth/connect/${TOKEN}`);
    assert.ok(!t.includes(TOKEN));
  });

  it('firewallManualCmd đúng 1 dòng PowerShell', () => {
    assert.equal(firewallManualCmd(28894), 'New-NetFirewallRule -DisplayName "OpenCode" -Direction Inbound -Protocol TCP -LocalPort 28894 -Action Allow');
  });
});

describe('locateCli', () => {
  it('.env có path: dùng ngay, KHÔNG dò thư mục', () => {
    let scanned = 0;
    const r = locateCli({ configured: CLI, existsFn: () => true, readdirFn: () => { scanned += 1; return []; } });
    assert.deepEqual(r, { path: CLI, status: 'ok' });
    assert.equal(scanned, 0);
  });

  it('.env có path nhưng file không tồn tại -> not-found, không dò', () => {
    let scanned = 0;
    const r = locateCli({ configured: CLI, existsFn: () => false, readdirFn: () => { scanned += 1; return []; } });
    assert.deepEqual(r, { path: CLI, status: 'not-found' });
    assert.equal(scanned, 0);
  });

  it('tự dò: chọn version lớn nhất theo số học (2.10.0 > 2.2.5), bỏ folder lạ', () => {
    const r = locateCli({
      env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
      existsFn: () => true,
      readdirFn: () => ['2.2.5-x64', '2.10.0-x64', '2.9.1-x64', 'junk', 'readme.txt']
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.path, 'C:\\Users\\x\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.10.0-x64\\opencode-cli.exe');
  });

  it('dò không ra / không có APPDATA / thư mục không đọc được -> missing', () => {
    const env = { APPDATA: 'C:\\A' };
    assert.equal(locateCli({ env, existsFn: () => true, readdirFn: () => ['junk'] }).status, 'missing');
    assert.equal(locateCli({ env: {}, existsFn: () => true }).status, 'missing');
    assert.equal(locateCli({ env, existsFn: () => true, readdirFn: () => { throw new Error('ENOENT'); } }).status, 'missing');
  });

  it('dò ra folder nhưng thiếu exe -> not-found', () => {
    const r = locateCli({ env: { APPDATA: 'C:\\A' }, existsFn: () => false, readdirFn: () => ['2.2.5-x64'] });
    assert.equal(r.status, 'not-found');
  });
});

describe('pickLanIp', () => {
  const a = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra });
  it('bỏ loopback/APIPA/IPv6, tránh card ảo, ưu tiên 192.168', () => {
    const ip = pickLanIp({
      'Loopback': [a('127.0.0.1', { internal: true })],
      'vEthernet (WSL)': [a('172.20.0.1')],
      'Ethernet 2': [a('169.254.1.1')],
      'VPN': [a('10.8.0.2')],
      'Wi-Fi': [a('192.168.1.50'), { address: 'fe80::1', family: 'IPv6', internal: false }],
      'Ethernet': [a('10.0.0.5')]
    });
    assert.equal(ip, '192.168.1.50');
  });

  it('chỉ có card ảo -> vẫn trả IP; không có gì -> null', () => {
    assert.equal(pickLanIp({ 'vEthernet (Default)': [a('172.30.0.1')] }), '172.30.0.1');
    assert.equal(pickLanIp({ lo: [a('127.0.0.1', { internal: true })] }), null);
  });
});

describe('flow Link Web', () => {
  it('đường vui: service LAN + firewall có sẵn -> gửi link, log KHÔNG chứa token', async () => {
    const { calls, svc } = makeService({
      script: { pair: { code: 0, out: PAIR_OUT }, 'fw-show': { code: 0, out: 'Rule Name: OpenCode' }, 'service-status': UP_LAN }
    });
    const ctx = fakeCtx();
    assert.equal(await svc.handleLink(ctx, ALLOWED), true);
    assert.equal(ctx.replies.length, 1);
    assert.ok(ctx.replies[0].text.includes(LINK));
    assert.ok(ctx.replies[0].text.includes('hết hạn sau 5 phút'));
    const pair = calls.find((c) => c.args[0] === 'pair');
    assert.deepEqual(pair.args, ['pair', '--url', 'http://192.168.1.50:28894']);
    assert.equal(pair.timeoutMs, 60000);
    assert.equal(sub(calls, 'start').length, 0);
    assert.equal(calls.some((c) => c.file.toLowerCase().endsWith('netsh.exe') && c.args[2] === 'add'), false);
    const logs = allFilesText();
    assert.ok(logs.includes('pair ok ip=192.168.1.50 port=28894'));
    assert.ok(!logs.includes(TOKEN), 'log/tasks không được chứa token');
    assert.ok(!logs.includes('/auth/connect/'), 'log không được chứa link');
  });

  it('firewall chưa có + thêm lỗi quyền -> gửi hướng dẫn nhưng vẫn gửi link', async () => {
    const { svc } = makeService({
      script: {
        'fw-add': { code: 1, out: 'The requested operation requires elevation.' },
        'fw-show': { code: 1, out: 'No rules match' },
        pair: { code: 0, out: PAIR_OUT },
        'service-status': UP_LAN
      }
    });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    assert.equal(ctx.replies.length, 2);
    assert.ok(ctx.replies[0].text.includes('New-NetFirewallRule'));
    assert.ok(ctx.replies[1].text.includes(LINK));
  });

  it('firewall chưa có + thêm OK -> không hướng dẫn tay', async () => {
    const { calls, svc } = makeService({
      script: { 'fw-show': { code: 1, out: '' }, pair: { code: 0, out: PAIR_OUT }, 'service-status': UP_LAN }
    });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    assert.equal(ctx.replies.length, 1);
    const add = calls.find((c) => c.args[2] === 'add');
    assert.ok(add.args.includes('localport=28894'));
  });

  it('người lạ: im lặng, không chạy lệnh nào', async () => {
    const { calls, svc } = makeService({ script: { 'service-status': UP_LAN } });
    const ctx = fakeCtx({ userId: 999 });
    assert.equal(await svc.handleLink(ctx, ALLOWED), false);
    assert.equal(ctx.replies.length, 0);
    assert.equal(calls.length, 0);
  });

  it('thiếu CLI: báo lỗi rõ, không chạy lệnh nào', async () => {
    const calls = [];
    const svc = createWebLinkService({
      config: { lanIp: null, pairTimeoutMs: 1000, v2CliPath: null },
      env: {},
      execFn: async (...a) => { calls.push(a); return { code: 0, out: '' }; }
    });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    assert.ok(ctx.replies[0].text.includes('Chưa tìm thấy opencode-cli V2'));
    assert.equal(calls.length, 0);
    assert.equal(svc.cliStatus(), 'thiếu');
  });

  it('CLI .env trỏ file không tồn tại: báo đúng path, cliStatus = không tồn tại', async () => {
    const calls = [];
    const svc = createWebLinkService({
      config: { lanIp: null, pairTimeoutMs: 1000, v2CliPath: CLI },
      env: {},
      execFn: async (...a) => { calls.push(a); return { code: 0, out: '' }; },
      existsFn: () => false
    });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    assert.ok(ctx.replies[0].text.includes(`Không thấy file: ${CLI}`));
    assert.equal(calls.length, 0);
    assert.equal(svc.cliStatus(), 'không tồn tại');
  });

  it('service DOWN: hỏi, KHÔNG tự start; bấm Không -> không chạy gì thêm', async () => {
    const { calls, svc } = makeService({ script: { 'service-status': { code: 1, out: 'not running' } } });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    assert.ok(ctx.replies[0].text.includes('chưa chạy. Bật lại?'));
    assert.equal(sub(calls, 'start').length, 0);
    const skip = fakeCtx({ data: ctx.replies[0].opts.reply_markup.inline_keyboard[0][1].callback_data });
    await svc.handleCallback(skip, ALLOWED);
    assert.equal(skip.replies[0].text, 'Đã bỏ qua.');
    assert.equal(sub(calls, 'start').length, 0);
  });

  it('service DOWN -> Bật lại: chạy start, poll tới khi lên, rồi gửi link', async () => {
    let started = false;
    const { calls, svc } = makeService({
      script: {
        pair: { code: 0, out: PAIR_OUT },
        'service-start': () => { started = true; return { code: 0, out: '' }; },
        'service-status': () => (started ? UP_LAN : { code: 1, out: 'down' })
      }
    });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    const yes = fakeCtx({ data: ctx.replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data });
    await svc.handleCallback(yes, ALLOWED);
    assert.equal(sub(calls, 'start').length, 1);
    assert.ok(yes.replies.at(-1).text.includes(LINK));
    // bấm lại nút cũ: đã bị claim
    const again = fakeCtx({ data: ctx.replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data });
    await svc.handleCallback(again, ALLOWED);
    assert.ok(again.replies[0].text.includes('hết hạn'));
    assert.equal(sub(calls, 'start').length, 1);
  });

  it('start không lên sau 20 lần poll -> báo lỗi kèm output đã lọc token', async () => {
    const { calls, svc } = makeService({
      script: {
        'service-start': { code: 0, out: `boot failed ${LINK}` },
        'service-status': { code: 1, out: 'down' }
      }
    });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    const yes = fakeCtx({ data: ctx.replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data });
    await svc.handleCallback(yes, ALLOWED);
    const last = yes.replies.at(-1).text;
    assert.ok(last.includes('Bật service lỗi'));
    assert.ok(!last.includes(TOKEN));
    assert.equal(calls.filter((c) => c.args[1] === 'status').length, 1 + 20);
  });

  it('host 127.0.0.1: cảnh báo restart; Huỷ -> không đổi hostname', async () => {
    const { calls, svc } = makeService({ script: { 'service-status': UP_LOCAL } });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    assert.ok(ctx.replies[0].text.includes('restart OpenCode service'));
    const cancel = fakeCtx({ data: ctx.replies[0].opts.reply_markup.inline_keyboard[0][1].callback_data });
    await svc.handleCallback(cancel, ALLOWED);
    assert.ok(cancel.replies[0].text.includes('Đã huỷ'));
    assert.equal(calls.some((c) => c.args[1] === 'set'), false);
    assert.equal(sub(calls, 'start').length, 0);
  });

  it('host 127.0.0.1: Tiếp tục -> set hostname 0.0.0.0, restart, rồi gửi link', async () => {
    let restarted = false;
    const { calls, svc } = makeService({
      script: {
        pair: { code: 0, out: PAIR_OUT },
        'service-start': () => { restarted = true; return { code: 0, out: '' }; },
        'service-status': () => (restarted ? UP_LAN : UP_LOCAL)
      }
    });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    const go = fakeCtx({ data: ctx.replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data });
    await svc.handleCallback(go, ALLOWED);
    const set = calls.find((c) => c.args[1] === 'set');
    assert.deepEqual(set.args, ['service', 'set', 'hostname', '0.0.0.0']);
    assert.ok(calls.indexOf(set) < calls.findIndex((c) => c.args[1] === 'start'));
    assert.ok(go.replies.at(-1).text.includes(LINK));
  });

  it('sau restart vẫn nghe 127.0.0.1 -> báo lỗi, không gửi link', async () => {
    const { svc } = makeService({ script: { 'service-status': UP_LOCAL } });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    const go = fakeCtx({ data: ctx.replies[0].opts.reply_markup.inline_keyboard[0][0].callback_data });
    await svc.handleCallback(go, ALLOWED);
    assert.ok(go.replies.at(-1).text.includes('vẫn nghe ở 127.0.0.1'));
    assert.ok(!go.replies.some((r) => r.text.includes('/auth/connect/')));
  });

  it('pair timeout: báo lỗi, không có link/token trong reply và log', async () => {
    const { svc } = makeService({
      config: { pairTimeoutMs: 1000 },
      script: { pair: { code: 1, out: `partial ${LINK}`, timedOut: true }, 'service-status': UP_LAN }
    });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    assert.ok(ctx.replies[0].text.includes('quá 1s'));
    assert.ok(!ctx.replies[0].text.includes(TOKEN));
    assert.ok(!allFilesText().includes(TOKEN));
  });

  it('pair không ra link: báo lỗi kèm ≤300 ký tự đầu, đã lọc token', async () => {
    const { svc } = makeService({
      script: { pair: { code: 2, out: `fail Bearer abcdef123456 /auth/connect/${TOKEN} ${'x'.repeat(500)}` }, 'service-status': UP_LAN }
    });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    const t = ctx.replies[0].text;
    assert.ok(t.includes('Không tìm thấy link'));
    assert.ok(!t.includes(TOKEN));
    assert.ok(!t.includes('abcdef123456'));
    assert.ok(t.length < 450);
    const logs = allFilesText();
    assert.ok(!logs.includes(TOKEN));
  });

  it('không có IP LAN và không có WEB_LAN_IP -> báo lỗi rõ', async () => {
    const { svc } = makeService({
      config: { lanIp: null },
      script: { 'fw-show': { code: 0, out: 'OpenCode' }, 'service-status': UP_LAN }
    });
    const ctx = fakeCtx();
    await svc.handleLink(ctx, ALLOWED);
    assert.ok(ctx.replies[0].text.includes('WEB_LAN_IP'));
  });

  it('dò IP LAN khi không đặt WEB_LAN_IP', async () => {
    const { calls, svc } = makeService({
      config: { lanIp: null },
      netFn: () => ({ 'Wi-Fi': [{ address: '192.168.7.9', family: 'IPv4', internal: false }] }),
      script: { 'fw-show': { code: 0, out: 'OpenCode' }, pair: { code: 0, out: PAIR_OUT }, 'service-status': UP_LAN }
    });
    await svc.handleLink(fakeCtx(), ALLOWED);
    assert.deepEqual(calls.find((c) => c.args[0] === 'pair').args, ['pair', '--url', 'http://192.168.7.9:28894']);
  });

  it('bấm nút lần 2 khi đang chạy -> không chạy song song', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = createWebLinkService({
      config: { lanIp: '192.168.1.50', pairTimeoutMs: 1000, v2CliPath: CLI },
      env: {},
      execFn: async (file, args) => { if (args[1] === 'status') await gate; return { code: 0, out: 'http://0.0.0.0:28894' }; },
      existsFn: () => true
    });
    const c1 = fakeCtx();
    const p1 = slow.handleLink(c1, ALLOWED);
    const c2 = fakeCtx();
    await slow.handleLink(c2, ALLOWED);
    assert.ok(c2.replies[0].text.includes('Đang xử lý'));
    release();
    await p1;
  });

  it('callback của người lạ: bị bỏ qua', async () => {
    const { svc } = makeService({ script: { 'service-status': UP_LAN } });
    const c = fakeCtx({ data: 'web:start:abc', userId: 999 });
    assert.equal(await svc.handleCallback(c, ALLOWED), true);
    assert.equal(c.replies.length, 0);
    assert.equal(await svc.handleCallback(fakeCtx({ data: 'go:pc:now' }), ALLOWED), false);
  });
});
