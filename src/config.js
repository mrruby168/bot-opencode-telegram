// Pure config loader — không đọc process.env trực tiếp, không import dotenv.
// dotenv được nạp trong bot.js với path tính từ import.meta.url.
import net from 'node:net';

export const DEFAULTS = {
  pairTimeoutMs: 60000
};

function required(env, name) {
  const v = env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`Missing env ${name} (see .env.example)`);
  }
  return String(v);
}

function optionalInt(env, name, def) {
  const v = env[name];
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid env ${name}: must be a non-negative integer`);
  return n;
}

function optionalString(env, name) {
  const v = String(env[name] ?? '').trim();
  return v === '' ? null : v;
}

function parseAllowedUsers(env) {
  const raw = required(env, 'TELEGRAM_ALLOWED_USERS');
  const ids = raw.split(/[,\s]+/).filter(Boolean).map((s) => Number(s));
  for (const id of ids) {
    if (!Number.isInteger(id)) {
      throw new Error('Invalid env TELEGRAM_ALLOWED_USERS: every id must be an integer');
    }
  }
  if (ids.length === 0) throw new Error('Invalid env TELEGRAM_ALLOWED_USERS: empty');
  return new Set(ids);
}

function parseLanIp(env) {
  const ip = optionalString(env, 'WEB_LAN_IP');
  if (ip !== null && !net.isIPv4(ip)) throw new Error('Invalid env WEB_LAN_IP: must be an IPv4 address');
  return ip;
}

export function loadConfig(env = {}) {
  return {
    allowedUsers: parseAllowedUsers(env),
    lanIp: parseLanIp(env),
    pairTimeoutMs: optionalInt(env, 'PAIR_TIMEOUT_MS', DEFAULTS.pairTimeoutMs),
    telegramBotToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    v2CliPath: optionalString(env, 'OPENCODE_V2_CLI')
  };
}
