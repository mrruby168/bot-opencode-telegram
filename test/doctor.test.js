import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor } from '../scripts/doctor.mjs';

const TOKEN = '87654321:' + 'A'.repeat(35);
const CLI = 'C:\\fake\\opencode-cli.exe';

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-doctor-'));
});
afterEach(() => {
  fs.rmSync(tmp, { force: true, recursive: true });
});

function writeEnv(extra = {}) {
  const f = path.join(tmp, '.env.test');
  const base = { TELEGRAM_ALLOWED_USERS: '1', TELEGRAM_BOT_TOKEN: TOKEN, ...extra };
  fs.writeFileSync(f, Object.entries(base).map(([k, v]) => `${k}=${v}`).join('\n'));
  return f;
}

function stubFetch({ getMe = 'ok' } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.telegram.org')) {
      if (getMe === 'ok') return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'fakebot' } }) };
      if (getMe === 'unauth') return { ok: false, status: 401 };
      throw new Error('net down');
    }
    throw new Error('unexpected url ' + url);
  };
  return { calls, fetchFn };
}

const okExec = async () => ({ err: null, out: '5.1\n' });

describe('doctor', () => {
  it('đủ 6 nhóm, không còn opencode-bin/server/model', async () => {
    const { fetchFn } = stubFetch();
    const r = await runDoctor({ env: {}, envFile: writeEnv(), execFn: okExec, fetchFn });
    assert.deepEqual(r.groups.map((g) => g.name), ['node', 'env', 'token', 'cli-v2', 'powershell', 'telegram']);
    assert.equal(r.failed, false);
    assert.ok(r.lines.join('\n').includes('@fakebot'));
  });

  it('KHÔNG BAO GIỜ in giá trị bí mật', async () => {
    const { fetchFn } = stubFetch({ getMe: 'unauth' });
    const r = await runDoctor({ env: {}, envFile: writeEnv(), execFn: okExec, fetchFn });
    assert.ok(!r.lines.join('\n').includes(TOKEN), 'token phải bị giấu');
    assert.equal(r.failed, true);
  });

  it('thiếu file env → fail; token sai dạng → fail và không gọi getMe', async () => {
    const { calls, fetchFn } = stubFetch({});
    const r1 = await runDoctor({ env: {}, envFile: path.join(tmp, 'nope.env'), execFn: okExec, fetchFn });
    assert.equal(r1.failed, true);
    const r2 = await runDoctor({ env: {}, envFile: writeEnv({ TELEGRAM_BOT_TOKEN: 'sai' }), execFn: okExec, fetchFn });
    assert.equal(r2.failed, true);
    assert.equal(r2.groups.find((g) => g.name === 'token').status, 'fail');
    assert.ok(!calls.some((u) => u.includes('api.telegram.org')), 'token sai thì không gọi getMe');
  });

  it('CLI V2 thiếu/không tồn tại → warn (không fail); powershell lỗi → warn', async () => {
    const { fetchFn } = stubFetch();
    const badExec = async () => ({ err: new Error('no bin'), out: '' });
    const r = await runDoctor({ env: {}, envFile: writeEnv({ OPENCODE_V2_CLI: CLI }), execFn: badExec, fetchFn, offline: true });
    const g = r.groups.find((x) => x.name === 'cli-v2');
    assert.equal(g.status, 'warn');
    assert.ok(g.detail.includes('OPENCODE_V2_CLI'));
    assert.equal(r.groups.find((x) => x.name === 'powershell').status, 'warn');
    assert.equal(r.groups.find((x) => x.name === 'telegram').detail.includes('--offline'), true);
    assert.equal(r.failed, false);
  });

  it('getMe 401 → fail (token đã thu hồi)', async () => {
    const { fetchFn } = stubFetch({ getMe: 'unauth' });
    const r = await runDoctor({ env: {}, envFile: writeEnv(), execFn: okExec, fetchFn });
    assert.equal(r.groups.find((g) => g.name === 'telegram').status, 'fail');
    assert.equal(r.failed, true);
  });
});
