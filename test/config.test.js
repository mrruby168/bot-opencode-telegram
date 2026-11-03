import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, loadConfig } from '../src/config.js';

const BASE = {
  TELEGRAM_ALLOWED_USERS: '1784770769',
  TELEGRAM_BOT_TOKEN: 'fake-token-for-test'
};

describe('loadConfig', () => {
  it('loads defaults', () => {
    const c = loadConfig({ ...BASE });
    assert.equal(c.v2CliPath, null);
    assert.equal(c.lanIp, null);
    assert.equal(c.pairTimeoutMs, DEFAULTS.pairTimeoutMs);
    assert.equal(c.pairTimeoutMs, 60000);
    assert.deepEqual([...c.allowedUsers], [1784770769]);
  });

  it('không còn khóa của OpenCode V1/MMO', () => {
    const c = loadConfig({ ...BASE });
    for (const k of ['opencodeBin', 'opencodeServerUrl', 'opencodeServerPort', 'mmoDir', 'taskTimeoutMs', 'permissionTtlMs', 'opencodeModel']) {
      assert.equal(k in c, false, k);
    }
  });

  it('missing TELEGRAM_BOT_TOKEN throws naming the var', () => {
    const { TELEGRAM_BOT_TOKEN, ...rest } = BASE;
    assert.throws(() => loadConfig(rest), /TELEGRAM_BOT_TOKEN/);
  });

  it('NaN user id throws naming TELEGRAM_ALLOWED_USERS', () => {
    assert.throws(
      () => loadConfig({ ...BASE, TELEGRAM_ALLOWED_USERS: '1784770769,abc' }),
      /TELEGRAM_ALLOWED_USERS/
    );
  });

  it('empty user list throws', () => {
    assert.throws(() => loadConfig({ ...BASE, TELEGRAM_ALLOWED_USERS: '  ' }), /TELEGRAM_ALLOWED_USERS/);
  });

  it('OPENCODE_V2_CLI, WEB_LAN_IP, PAIR_TIMEOUT_MS được đọc', () => {
    const c = loadConfig({ ...BASE, OPENCODE_V2_CLI: ' C:\\x\\opencode-cli.exe ', PAIR_TIMEOUT_MS: '5000', WEB_LAN_IP: '192.168.1.5' });
    assert.equal(c.v2CliPath, 'C:\\x\\opencode-cli.exe');
    assert.equal(c.pairTimeoutMs, 5000);
    assert.equal(c.lanIp, '192.168.1.5');
  });

  it('giá trị rỗng = mặc định; WEB_LAN_IP sai và PAIR_TIMEOUT_MS sai bị từ chối', () => {
    const c = loadConfig({ ...BASE, OPENCODE_V2_CLI: '', PAIR_TIMEOUT_MS: '', WEB_LAN_IP: '' });
    assert.equal(c.v2CliPath, null);
    assert.equal(c.lanIp, null);
    assert.equal(c.pairTimeoutMs, 60000);
    assert.throws(() => loadConfig({ ...BASE, WEB_LAN_IP: 'abc' }), /WEB_LAN_IP/);
    assert.throws(() => loadConfig({ ...BASE, PAIR_TIMEOUT_MS: 'abc' }), /PAIR_TIMEOUT_MS/);
  });
});
