import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// What the Config page controls beyond import/export (that part is
// tests/config-transfer.test.js): the credential encryption key, the optional
// login, and the Host allowlist.
//
// db.js opens a SQLite file at import time — point it at a throwaway dir before
// the dynamic import, so the tests never touch the real data directory. The
// env vars are cleared for the same reason: they are read once at import, and
// they override the settings-backed values these tests are about.
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-config-'));
delete process.env.FLATLINE_SECRET_KEY;
delete process.env.FLATLINE_PASSWORD;
delete process.env.FLATLINE_ALLOWED_HOSTS;

const store = await import('../server/db.js');
const secrets = await import('../server/secrets.js');
const security = await import('../server/security.js');

const KEY_FILE = path.join(store.dataDir, 'secret.key');
const KEY_FILE_STAGED = KEY_FILE + '.next';

/** Mirrors the /api/config/key route: re-encrypt every stored blob in one transaction. */
function rewriteAllRows(reencrypt) {
  store.updateEncryptedRows(store.allEncryptedRows().map((r) => ({ ...r, secret_enc: reencrypt(r.secret_enc) })));
}

function credentialTarget(name, fields) {
  return store.createActionTarget({
    name, kind: 'ssh',
    config: JSON.stringify({ host: 'h', username: 'u', port: 22, auth_method: 'password', command: 'poweroff' }),
    secret_enc: secrets.encryptSecrets(fields), enabled: 1
  });
}

// ---- the encryption key ----

test('a key is accepted as 64 hex chars or base64, and nothing else', () => {
  const raw = crypto.randomBytes(32);
  assert.deepEqual(secrets.parseKeyInput(raw.toString('hex')), raw);
  assert.deepEqual(secrets.parseKeyInput(raw.toString('base64')), raw);
  assert.deepEqual(secrets.parseKeyInput(`  ${raw.toString('hex')}  `), raw, 'surrounding space is tolerated');

  assert.equal(secrets.parseKeyInput('too short'), null);
  assert.equal(secrets.parseKeyInput(crypto.randomBytes(16).toString('hex')), null, '16 bytes is not enough');
  assert.equal(secrets.parseKeyInput(''), null);
  assert.equal(secrets.parseKeyInput(null), null);
});

test('secrets round-trip, and only the field names are readable from a blob', () => {
  const blob = secrets.encryptSecrets({ password: 'hunter2', token: 'abc123', unused: '' });

  assert.deepEqual(secrets.decryptSecrets(blob), { password: 'hunter2', token: 'abc123' });
  assert.deepEqual(secrets.secretKeys(blob).sort(), ['password', 'token'], 'empty fields are not stored');
  assert.ok(!blob.includes('hunter2'));

  // Nothing to protect means nothing stored, so the page can say "not set".
  assert.equal(secrets.encryptSecrets({}), null);
  assert.equal(secrets.encryptSecrets({ password: '' }), null);
  assert.deepEqual(secrets.decryptSecrets(null), {});
});

test('a tampered blob is rejected rather than half-decrypted', () => {
  const blob = secrets.encryptSecrets({ password: 'hunter2' });
  // Flip a byte of the ciphertext — the GCM auth tag must catch it.
  const body = Buffer.from(blob.slice(3), 'base64');
  body[body.length - 1] ^= 0xff;
  const tampered = 'v1:' + body.toString('base64');

  assert.throws(() => secrets.decryptSecrets(tampered));
  assert.deepEqual(secrets.secretKeys(tampered), [], 'and it reports no fields rather than throwing at the caller');
  assert.throws(() => secrets.decryptSecrets('plaintext'), /unknown secret format/);
});

test('rotating the key re-encrypts every stored credential', () => {
  const a = credentialTarget('rotate-a', { password: 'first-secret' });
  const b = credentialTarget('rotate-b', { token: 'second-secret' });
  const before = store.getActionTarget(a.id).secret_enc;
  const keyBefore = readFileSync(KEY_FILE, 'utf-8');

  const result = secrets.rotateKey(null, rewriteAllRows); // null = generate one

  assert.equal(result.source, 'file');
  assert.equal(result.generated, true);
  assert.notEqual(readFileSync(KEY_FILE, 'utf-8'), keyBefore, 'the key file holds the new key');
  assert.ok(!existsSync(KEY_FILE_STAGED), 'the staged file is gone once the swap is done');

  // Every blob is different on disk, but reads back the same.
  assert.notEqual(store.getActionTarget(a.id).secret_enc, before);
  assert.deepEqual(secrets.decryptSecrets(store.getActionTarget(a.id).secret_enc), { password: 'first-secret' });
  assert.deepEqual(secrets.decryptSecrets(store.getActionTarget(b.id).secret_enc), { token: 'second-secret' });
});

test('rotating to a key you supply works, but not to the one already in use', () => {
  const t = credentialTarget('rotate-explicit', { password: 'still-here' });
  const supplied = crypto.randomBytes(32);

  const result = secrets.rotateKey(supplied, rewriteAllRows);
  assert.equal(result.generated, false);
  assert.equal(readFileSync(KEY_FILE, 'utf-8').trim(), supplied.toString('hex'));
  assert.deepEqual(secrets.decryptSecrets(store.getActionTarget(t.id).secret_enc), { password: 'still-here' });

  assert.throws(() => secrets.rotateKey(supplied, rewriteAllRows), /same as the current key/);
});

test('a rotation that fails partway leaves the old key and the data intact', () => {
  const t = credentialTarget('rotate-fails', { password: 'must-survive' });
  const keyBefore = readFileSync(KEY_FILE, 'utf-8');
  const blobBefore = store.getActionTarget(t.id).secret_enc;

  assert.throws(() => secrets.rotateKey(crypto.randomBytes(32), () => {
    throw new Error('disk exploded mid-rewrite');
  }), /disk exploded/);

  assert.equal(readFileSync(KEY_FILE, 'utf-8'), keyBefore, 'the live key is untouched');
  assert.ok(!existsSync(KEY_FILE_STAGED), 'the staged key is cleaned up');
  assert.equal(store.getActionTarget(t.id).secret_enc, blobBefore);
  assert.deepEqual(secrets.decryptSecrets(blobBefore), { password: 'must-survive' });
});

// ---- crash recovery ----
// A rotation dying between the row rewrite and the key-file rename leaves the
// data under the new key and the file holding the old one. Startup has to spot
// that and promote the staged key, or every credential is unreadable.
//
// Each case needs a secrets.js that hasn't cached a key yet, which is what the
// ?fresh query gives: a second instance of the module, reading the key file
// from scratch. The instance imported at the top of this file is stale from
// here on, so these two tests come last.

test('an interrupted rotation is recovered by promoting the staged key', async () => {
  const t = credentialTarget('interrupted', { password: 'recover-me' });
  const oldKeyFile = readFileSync(KEY_FILE, 'utf-8');
  const newKey = crypto.randomBytes(32);

  // Do a full rotation, then put the key file back — the state a crash between
  // step 2 (rows rewritten) and step 3 (file renamed) would leave behind.
  secrets.rotateKey(newKey, rewriteAllRows);
  writeFileSync(KEY_FILE, oldKeyFile);
  writeFileSync(KEY_FILE_STAGED, newKey.toString('hex') + '\n');

  const fresh = await import('../server/secrets.js?case=interrupted');
  assert.throws(() => fresh.decryptSecrets(store.getActionTarget(t.id).secret_enc),
    'the old key really cannot read the rewritten rows');

  const recovered = await import('../server/secrets.js?case=recovered');
  recovered.recoverStagedKey(store.allEncryptedRows().map((r) => r.secret_enc));

  assert.equal(readFileSync(KEY_FILE, 'utf-8').trim(), newKey.toString('hex'), 'the staged key was promoted');
  assert.ok(!existsSync(KEY_FILE_STAGED));
  assert.deepEqual(recovered.decryptSecrets(store.getActionTarget(t.id).secret_enc), { password: 'recover-me' });
});

test('a stale staged key is discarded when the live key still reads the data', async () => {
  const t = credentialTarget('stale-staged', { password: 'unaffected' });
  const liveKeyFile = readFileSync(KEY_FILE, 'utf-8');
  writeFileSync(KEY_FILE_STAGED, crypto.randomBytes(32).toString('hex') + '\n');

  const fresh = await import('../server/secrets.js?case=stale');
  fresh.recoverStagedKey(store.allEncryptedRows().map((r) => r.secret_enc));

  assert.ok(!existsSync(KEY_FILE_STAGED), 'the leftover file is removed');
  assert.equal(readFileSync(KEY_FILE, 'utf-8'), liveKeyFile, 'and it did not overwrite a working key');
  assert.deepEqual(fresh.decryptSecrets(store.getActionTarget(t.id).secret_enc), { password: 'unaffected' });
});

// ---- the optional login ----

/** Enough of an http.IncomingMessage for the auth functions. */
function request(ip, cookie = null) {
  return { socket: { remoteAddress: ip }, headers: cookie ? { cookie } : {} };
}

/** The `name=value` part of a Set-Cookie string, as a browser would send it back. */
function asCookie(setCookie) {
  return setCookie.split(';')[0];
}

function setPassword(password) {
  store.setSetting('auth_password_hash', security.hashPassword(password));
  security.invalidateSecurityCache();
}

test('with no password set, the instance is open', () => {
  assert.equal(security.authRequired(), false);
  assert.equal(security.passwordSource(), null);
  assert.equal(security.isAuthenticated(request('10.0.0.1')), true, 'no login means nothing to check');
  assert.equal(security.login(request('10.0.0.1'), 'anything'), null, 'and there is no session to hand out');
});

test('setting a password turns on the login, and only the right one gets in', () => {
  setPassword('correct horse battery staple');

  assert.equal(security.authRequired(), true);
  assert.equal(security.passwordSource(), 'settings');
  assert.equal(security.isAuthenticated(request('10.0.0.2')), false, 'a cookieless request is now rejected');

  assert.equal(security.login(request('10.0.0.2'), 'wrong'), null);
  assert.equal(security.login(request('10.0.0.2'), ''), null);

  const setCookie = security.login(request('10.0.0.2'), 'correct horse battery staple');
  assert.ok(setCookie, 'the right password mints a session');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const cookie = asCookie(setCookie);
  assert.equal(security.isAuthenticated(request('10.0.0.2', cookie)), true);
  assert.equal(security.isAuthenticated(request('10.0.0.2', 'flatline_session=made-up')), false);

  security.logout(request('10.0.0.2', cookie));
  assert.equal(security.isAuthenticated(request('10.0.0.2', cookie)), false, 'the session is gone after logout');
});

test('the stored password is a one-way hash, not the password', () => {
  setPassword('reversible?');
  const stored = store.getSettings().auth_password_hash;

  assert.match(stored, /^s1:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.ok(!stored.includes('reversible'));
  // Salted: the same password hashes differently every time.
  assert.notEqual(security.hashPassword('reversible?'), security.hashPassword('reversible?'));
});

test('repeated failures from one address are rate limited', () => {
  setPassword('brute-force-me');
  const attacker = '10.0.0.99';

  for (let i = 0; i < 10; i++) {
    assert.equal(security.login(request(attacker), `guess-${i}`), null);
  }
  assert.throws(() => security.login(request(attacker), 'guess-11'), (err) => err.status === 429);

  // Only that address is affected, and only failures count towards the limit.
  assert.ok(security.login(request('10.0.0.100'), 'brute-force-me'));
});

// ---- the Host allowlist ----

test('the Host allowlist blocks unknown names but never gets in the way of an IP', () => {
  assert.equal(security.allowedHostsSource(), 'settings');

  assert.equal(security.hostAllowed('localhost:3131'), true);
  assert.equal(security.hostAllowed('192.168.1.50:3131'), true, 'an IP literal cannot be rebound');
  assert.equal(security.hostAllowed('[::1]:3131'), true);
  assert.equal(security.hostAllowed('flatline.lan'), false, 'a name has to be allowlisted first');
  assert.equal(security.hostAllowed(''), false);
  assert.equal(security.hostAllowed(undefined), false);

  store.setSetting('allowed_hosts', 'flatline.lan, Monitor.Home');
  security.invalidateSecurityCache();

  assert.equal(security.hostAllowed('flatline.lan:3131'), true);
  assert.equal(security.hostAllowed('monitor.home'), true, 'the list is case-insensitive');
  assert.equal(security.hostAllowed('evil.example.com'), false);
});
