import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './db.js';

/**
 * Encryption at rest for infrastructure credentials (passwords, private keys,
 * API tokens, kubeconfigs). AES-256-GCM with a random 96-bit IV per value and
 * the auth tag verified on decrypt, so ciphertexts are tamper-evident.
 *
 * Key source, in order:
 *   1. FLATLINE_SECRET_KEY env var — 32 bytes as 64 hex chars or base64.
 *      Set this in production/Docker so the key never sits next to the db.
 *   2. <data dir>/secret.key — auto-generated on first use (file mode 0600).
 *
 * If the key is lost, stored secrets are unrecoverable by design; non-secret
 * target config survives and secrets can simply be re-entered.
 *
 * Secret values must never leave the server process: the API only ever
 * reports WHICH secret fields are set (see secretKeys), never their values,
 * and nothing here is ever logged.
 */

const KEY_FILE = path.join(dataDir, 'secret.key');
const KEY_FILE_STAGED = KEY_FILE + '.next';
let cachedKey = null;

/** Parses user/env key input: 64 hex chars or base64 for exactly 32 bytes. Returns Buffer or null. */
export function parseKeyInput(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    const b64 = Buffer.from(s, 'base64');
    if (b64.length === 32) return b64;
  }
  return null;
}

/** Where the active key comes from — the config page shows this and it decides how rotation works. */
export function keySource() {
  return process.env.FLATLINE_SECRET_KEY ? 'env' : 'file';
}

function loadKey() {
  if (cachedKey) return cachedKey;

  const env = process.env.FLATLINE_SECRET_KEY;
  if (env) {
    const key = parseKeyInput(env);
    if (!key) {
      throw new Error('FLATLINE_SECRET_KEY must be 32 bytes, encoded as 64 hex chars or base64');
    }
    cachedKey = key;
    return cachedKey;
  }

  if (existsSync(KEY_FILE)) {
    const key = Buffer.from(readFileSync(KEY_FILE, 'utf-8').trim(), 'hex');
    if (key.length !== 32) throw new Error(`${KEY_FILE} is corrupt (expected 64 hex chars)`);
    cachedKey = key;
    return cachedKey;
  }

  const key = crypto.randomBytes(32);
  writeFileSync(KEY_FILE, key.toString('hex') + '\n', { mode: 0o600 });
  console.log(`[secrets] generated new encryption key at ${KEY_FILE} — back it up; without it stored credentials are unrecoverable`);
  cachedKey = key;
  return cachedKey;
}

function encryptWith(key, obj) {
  const entries = Object.entries(obj ?? {}).filter(([, v]) => typeof v === 'string' && v.length > 0);
  if (entries.length === 0) return null;

  const plaintext = Buffer.from(JSON.stringify(Object.fromEntries(entries)), 'utf-8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decryptWith(key, stored) {
  if (!stored) return {};
  if (!stored.startsWith('v1:')) throw new Error('unknown secret format');
  const raw = Buffer.from(stored.slice(3), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf-8'));
}

/** Encrypts an object of secret fields. Returns an opaque string for storage, or null for empty input. */
export function encryptSecrets(obj) {
  return encryptWith(loadKey(), obj);
}

/** Decrypts a stored blob back to the secret-fields object. Throws if tampered or wrong key. */
export function decryptSecrets(stored) {
  return decryptWith(loadKey(), stored);
}

// ---- key rotation ----
// Rotation re-encrypts every stored blob under a new key. Ordering makes a
// crash mid-rotation recoverable: (1) the new key is staged to secret.key.next,
// (2) the DB rows are rewritten in one transaction, (3) the staged file is
// renamed over secret.key. If the process dies between 2 and 3, startup finds
// secret.key.next, probes which key actually decrypts the rows, and promotes
// or discards the staged file accordingly (see recoverStagedKey).
//
// When the key comes from FLATLINE_SECRET_KEY instead of the key file, only a
// caller-supplied key is accepted (the server never reveals generated key
// material), no file is written, and the caller must update the env var
// before the next restart — the new key stays active in memory until then.

/**
 * Re-encrypts all blobs under newKey (random if null; forbidden for env keys).
 * rewriteRows(reencrypt) must persist every blob transactionally, where
 * reencrypt(blob) maps an old ciphertext to the new one.
 * Returns { source, generated } — never the key itself.
 */
export function rotateKey(newKey, rewriteRows) {
  const source = keySource();
  const generated = newKey == null;
  if (generated) {
    if (source === 'env') {
      throw new Error('the key is set via FLATLINE_SECRET_KEY — supply the new key explicitly, then update the environment variable');
    }
    newKey = crypto.randomBytes(32);
  }
  const oldKey = loadKey();
  if (newKey.equals(oldKey)) throw new Error('the new key is the same as the current key');

  if (source === 'file') {
    writeFileSync(KEY_FILE_STAGED, newKey.toString('hex') + '\n', { mode: 0o600 });
  }
  try {
    rewriteRows((blob) => encryptWith(newKey, decryptWith(oldKey, blob)));
  } catch (err) {
    if (source === 'file') rmSync(KEY_FILE_STAGED, { force: true });
    throw err;
  }
  if (source === 'file') {
    renameSync(KEY_FILE_STAGED, KEY_FILE);
  }
  cachedKey = newKey;
  return { source, generated };
}

/**
 * Startup self-heal for a rotation interrupted between the DB rewrite and the
 * key-file rename. probeBlobs: a few stored ciphertexts to test against.
 */
export function recoverStagedKey(probeBlobs) {
  if (!existsSync(KEY_FILE_STAGED)) return;
  if (keySource() === 'env') {
    // Stale leftover from before the env var was introduced — the env key rules.
    rmSync(KEY_FILE_STAGED, { force: true });
    return;
  }
  const staged = parseKeyInput(readFileSync(KEY_FILE_STAGED, 'utf-8'));
  const decryptsAll = (key) => probeBlobs.every((b) => { try { decryptWith(key, b); return true; } catch { return false; } });

  if (staged && (probeBlobs.length === 0 ? false : decryptsAll(staged)) && !decryptsAll(loadKey())) {
    renameSync(KEY_FILE_STAGED, KEY_FILE);
    cachedKey = staged;
    console.warn('[secrets] recovered from an interrupted key rotation — promoted the staged key, which matches the stored data');
  } else {
    rmSync(KEY_FILE_STAGED, { force: true });
    console.warn('[secrets] removed a stale staged key file left by an interrupted rotation (current key still matches the stored data)');
  }
}

/** Names of the secret fields stored in a blob — safe to expose; values are not. */
export function secretKeys(stored) {
  try {
    return Object.keys(decryptSecrets(stored));
  } catch {
    return [];
  }
}
