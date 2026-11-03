// doctor: kiểm tra môi trường tele-commander trước khi chạy bot.
// Chạy tay: node scripts/doctor.mjs [--offline]. KHÔNG nằm trong npm test.
// Env: DOCTOR_ENV_FILE (mặc định <project>/.env).
// KHÔNG BAO GIỜ in giá trị bí mật (chỉ tên biến + trạng thái + gợi ý).
// Exit 0 khi không có lỗi nặng (fail), 1 khi có ít nhất 1 fail.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { cliErrorMessage, locateCli } from '../src/weblink.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const REQUIRED_NODE = [22, 14, 0];

export function parseEnvFile(text) {
  const env = {};
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) env[key] = val;
  }
  return env;
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function defaultExecFn(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    // Windows: bin có thể là .ps1/.cmd nên phải qua shell.
    execFile(bin, args, { shell: process.platform === 'win32', timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout ?? '') + String(stderr ?? '') });
    });
  });
}

async function fetchWithTimeout(fetchFn, url, opts = {}, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Trả { failed, lines }: failed=true khi có ít nhất 1 nhóm fail.
export async function runDoctor({ envFile = null, env = process.env, fetchFn = fetch, execFn = defaultExecFn, offline = false } = {}) {
  const lines = [];
  const groups = [];
  const file = envFile || env.DOCTOR_ENV_FILE || path.join(PROJECT, '.env');
  const say = (s) => lines.push(s);
  const add = (name, status, detail) => {
    groups.push({ detail, name, status });
    say(`[${status.toUpperCase()}] ${name}${detail ? `: ${detail}` : ''}`);
  };

  // 1. Node version.
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(process.version || '');
  const ver = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  add('node', cmpVer(ver, REQUIRED_NODE) >= 0 ? 'ok' : 'fail', `${process.version} (cần >=22.14)`);

  // 2. .env đủ biến (đọc file, validate bằng loadConfig — không in giá trị).
  let fileEnv = {};
  if (!fs.existsSync(file)) {
    add('env', 'fail', `thiếu file ${file} (copy từ .env.example rồi điền)`);
  } else {
    try {
      fileEnv = parseEnvFile(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      add('env', 'fail', `đọc file lỗi (${String(e?.message ?? e).slice(0, 100)})`);
      fileEnv = null;
    }
  }
  let config = null;
  if (fileEnv) {
    try {
      config = loadConfig({ ...env, ...fileEnv });
      const names = Object.keys(fileEnv).length;
      add('env', 'ok', `${names} biến trong file, loadConfig hợp lệ`);
    } catch (e) {
      add('env', 'fail', String(e?.message ?? e).slice(0, 160));
    }
  }

  // 3. Dạng token (đúng/sai shape, không in token).
  const token = String(fileEnv?.TELEGRAM_BOT_TOKEN ?? '');
  if (!token) {
    add('token', 'fail', 'TELEGRAM_BOT_TOKEN chưa đặt');
  } else if (/^\d{8,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    add('token', 'ok', 'đúng dạng <id>:<chuỗi dài>');
  } else {
    add('token', 'fail', 'sai dạng (lấy từ BotFather, dạng số:chuỗi-dài)');
  }

  // 4. CLI V2 của OpenCode Desktop (chỉ cần cho nút Link Web; thiếu = warn).
  const loc = locateCli({ configured: config?.v2CliPath ?? null, env });
  if (loc.status === 'ok') add('cli-v2', 'ok', loc.path);
  else add('cli-v2', 'warn', `${cliErrorMessage(loc)} (nút Link Web sẽ báo lỗi, 2 tính năng kia vẫn chạy)`);

  // 4b. PowerShell cho /screenshot (Windows).
  try {
    const { err, out } = await execFn('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'], 5000);
    if (err && !String(out || '').trim()) add('powershell', 'warn', 'không chạy được powershell.exe (/screenshot sẽ lỗi)');
    else add('powershell', 'ok', 'powershell.exe khả dụng cho /screenshot');
  } catch (e) {
    add('powershell', 'warn', `lỗi kiểm tra powershell (${String(e?.message ?? e).slice(0, 80)})`);
  }

  // 5. getMe (trừ khi --offline).
  if (offline) {
    add('telegram', 'ok', 'bỏ qua getMe (--offline)');
  } else if (!/^\d{8,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    add('telegram', 'fail', 'token sai dạng nên không gọi getMe');
  } else {
    try {
      const res = await fetchWithTimeout(fetchFn, `https://api.telegram.org/bot${token}/getMe`, {}, 10000);
      if (res.ok) {
        const data = await res.json();
        const uname = data?.result?.username || '?';
        add('telegram', 'ok', `getMe thấy bot @${uname}`);
      } else if (res.status === 401 || res.status === 404) {
        add('telegram', 'fail', `getMe HTTP ${res.status}: token sai hoặc đã thu hồi (làm mới ở BotFather)`);
      } else {
        add('telegram', 'warn', `getMe HTTP ${res.status}: thử lại sau`);
      }
    } catch (e) {
      add('telegram', 'warn', `không gọi được Telegram (${String(e?.message ?? e).slice(0, 80)}); kiểm tra mạng hoặc chạy --offline`);
    }
  }

  const failed = groups.some((g) => g.status === 'fail');
  return { failed, groups, lines };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Dùng: node scripts/doctor.mjs [--offline] [--env-file <path>]');
    console.log('  DOCTOR_ENV_FILE: đường dẫn file .env cần kiểm tra (mặc định <project>/.env).');
    console.log('  Không bao giờ in giá trị bí mật.');
    process.exit(0);
  }
  const offline = args.includes('--offline');
  const ei = args.indexOf('--env-file');
  const envFile = ei >= 0 && args[ei + 1] ? args[ei + 1] : null;
  const { failed, lines } = await runDoctor({ envFile, offline });
  for (const l of lines) console.log(l);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
