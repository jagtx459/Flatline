import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The FLATLINE_PASSWORD login path. It needs its own file because the env var
// is read once at import time — tests/config-security.test.js deletes it to get
// at the settings-backed password, so the two can't share a process.
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-envpw-'));
delete process.env.FLATLINE_SECRET_KEY;
delete process.env.FLATLINE_ALLOWED_HOSTS;
process.env.FLATLINE_PASSWORD = 'correct-horse-battery-staple';

const security = await import('../server/security.js');

// A fresh address per login: only failures count toward the rate limit, but
// sharing one address across the failure cases would still walk toward it.
let n = 0;
const req = (cookie) => ({ socket: { remoteAddress: `203.0.113.${++n}` }, headers: cookie ? { cookie } : {} });

test('the env password takes precedence and turns the login on', () => {
  assert.equal(security.passwordSource(), 'env');
  assert.equal(security.authRequired(), true);
});

test('only the right password gets in', () => {
  assert.equal(typeof security.login(req(), 'correct-horse-battery-staple'), 'string');
  assert.equal(security.login(req(), 'wrong'), null);
  assert.equal(security.login(req(), ''), null);
  assert.equal(security.login(req(), null), null);
  // A prefix and an extension of the real password are both wrong.
  assert.equal(security.login(req(), 'correct-horse-battery-stapl'), null);
  assert.equal(security.login(req(), 'correct-horse-battery-staple2'), null);
});

test('the session minted by an env-password login authenticates', () => {
  const token = /=([^;]+)/.exec(security.login(req(), 'correct-horse-battery-staple'))[1];
  assert.equal(security.isAuthenticated(req(`flatline_session=${token}`)), true);
  assert.equal(security.isAuthenticated(req()), false);
});
