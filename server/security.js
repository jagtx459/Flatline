import crypto from 'node:crypto';
import * as store from './db.js';

/**
 * HTTP-layer security for the internal API. Everything here is dependency-
 * free and deliberately simple:
 *
 *  - Strict JSON body handling: content-type enforced, size capped up front
 *    via content-length and again while streaming, malformed JSON -> 400
 *    (never a 500), all signalled with HttpError so the top-level handler
 *    can map them to proper statuses.
 *  - Host-header validation to block DNS-rebinding: a malicious page can't
 *    point its own domain at this server and drive the API from a victim's
 *    browser. IP-literal hosts and localhost are always fine (that's how a
 *    homelab reaches it); real hostnames must be allowlisted via
 *    FLATLINE_ALLOWED_HOSTS (comma-separated).
 *  - Response security headers incl. a CSP that only allows same-origin
 *    scripts/styles/requests.
 *  - Opt-in session auth: set FLATLINE_PASSWORD, or set a password from the
 *    config page (stored as a scrypt hash in settings; the env var always
 *    wins when both exist). Every page/API call then requires a login.
 *    Sessions are random 256-bit tokens in memory (a restart just means
 *    logging in again), delivered as an HttpOnly SameSite=Strict cookie —
 *    which also makes cross-site request forgery a non-issue for
 *    authenticated setups. Login attempts are rate limited and compared in
 *    constant time.
 *
 * Settings-backed values (password hash, allowed hosts) are cached briefly
 * because they're consulted on every request; the config routes call
 * invalidateSecurityCache() after writing so changes apply immediately.
 */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------- request body ----------------

const MAX_BODY_BYTES = 1_000_000;

export async function readJsonBody(req) {
  const ctype = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (ctype !== 'application/json') {
    throw new HttpError(415, 'content-type must be application/json');
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'body too large');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return parsed;
}

// ---------------- settings-backed config (cached) ----------------

const ENV_ALLOWED_HOSTS = process.env.FLATLINE_ALLOWED_HOSTS; // undefined = not set
const ENV_PASSWORD = process.env.FLATLINE_PASSWORD || null;

const SETTINGS_CACHE_MS = 5000;
let settingsCache = { ts: 0, passwordHash: null, allowedHosts: new Set() };

function cachedSettings() {
  if (Date.now() - settingsCache.ts > SETTINGS_CACHE_MS) {
    const s = store.getSettings();
    settingsCache = {
      ts: Date.now(),
      passwordHash: s.auth_password_hash || null,
      allowedHosts: parseHostList(s.allowed_hosts ?? '')
    };
  }
  return settingsCache;
}

export function invalidateSecurityCache() {
  settingsCache.ts = 0;
}

export function parseHostList(value) {
  return new Set(String(value).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
}

// ---------------- same-origin enforcement ----------------
// The API is internal plumbing for the Flatline pages — nothing else is
// supposed to call it. Browsers label every request with Sec-Fetch-Site
// and/or Origin, so:
//   - any explicit cross-site evidence is rejected outright, and
//   - state-changing requests must positively prove same-origin, which also
//     blocks non-browser callers (curl, scripts) that don't mimic the UI.
// Reads without any origin headers stay allowed — the Docker healthcheck and
// older browsers send none — and are still behind the login when a password
// is set, which is the real boundary: headers can be forged, sessions can't.

export function crossOriginBlocked(req, mutating) {
  const sfs = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  const origin = req.headers.origin;

  let originMatches = null; // null = header absent
  if (origin) {
    try {
      originMatches = new URL(origin).host === req.headers.host;
    } catch {
      originMatches = false;
    }
  }

  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return true;
  if (originMatches === false) return true;
  if (mutating && sfs !== 'same-origin' && originMatches !== true) return true;
  return false;
}

// ---------------- host validation (DNS-rebinding guard) ----------------

const ENV_HOST_SET = parseHostList(ENV_ALLOWED_HOSTS ?? '');

export function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  let hostname;
  try {
    // Piggyback on the URL parser to strip the port and unbracket IPv6.
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  // Env var wins entirely when set; otherwise the settings-stored list applies.
  const allowed = ENV_ALLOWED_HOSTS !== undefined ? ENV_HOST_SET : cachedSettings().allowedHosts;
  if (allowed.has(hostname)) return true;
  // IP literals can't be rebound — the browser resolved nothing to get here.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.startsWith('[') || /^[0-9a-f:]+$/i.test(hostname)) return true; // IPv6
  return false;
}

/** Where the Host allowlist comes from — the config page shows/edits this. */
export function allowedHostsSource() {
  return ENV_ALLOWED_HOSTS !== undefined ? 'env' : 'settings';
}

// ---------------- response headers ----------------

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // pages use inline style attributes
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

export function applySecurityHeaders(res) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
}

// ---------------- rate limiting ----------------

/** bucketKey -> [timestamps]. Fixed small scope (per-IP login + API), pruned on use. */
const rateBuckets = new Map();

export function rateLimit(bucketKey, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(bucketKey) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    rateBuckets.set(bucketKey, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(bucketKey, hits);
  return true;
}

/** Like rateLimit but split: check without recording, record explicitly. */
function overLimit(bucketKey, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(bucketKey) ?? []).filter((t) => now - t < windowMs);
  rateBuckets.set(bucketKey, hits);
  return hits.length >= max;
}

function recordHit(bucketKey) {
  const hits = rateBuckets.get(bucketKey) ?? [];
  hits.push(Date.now());
  rateBuckets.set(bucketKey, hits);
}

// Keep the bucket map from growing unboundedly.
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateBuckets) {
    if (hits.length === 0 || now - hits[hits.length - 1] > 3_600_000) rateBuckets.delete(key);
  }
}, 600_000).unref();

// ---------------- opt-in session auth ----------------

const SESSION_COOKIE = 'flatline_session';
const SESSION_TTL_MS = 7 * 86_400_000;

/** token -> expiry ts */
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (expiry < now) sessions.delete(token);
  }
}, 600_000).unref();

/** 'env' (FLATLINE_PASSWORD), 'settings' (set from the config page), or null. */
export function passwordSource() {
  if (ENV_PASSWORD) return 'env';
  return cachedSettings().passwordHash ? 'settings' : null;
}

export function authRequired() {
  return passwordSource() !== null;
}

function timingSafeEquals(a, b) {
  // Hash both sides so lengths match and the comparison is constant time.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// scrypt for the settings-stored password — the hash sits in the same DB as
// everything else, so it must not be reversible.
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `s1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [tag, saltHex, hashHex] = String(stored).split(':');
  if (tag !== 's1' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return false;
  if (ENV_PASSWORD) return timingSafeEquals(password, ENV_PASSWORD);
  const stored = cachedSettings().passwordHash;
  return stored ? verifyPassword(password, stored) : false;
}

/** Mints a session and returns its Set-Cookie value. */
export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

/** Drops every session except the requester's — used when the password changes. */
export function resetOtherSessions(req) {
  const keep = parseCookies(req)[SESSION_COOKIE];
  for (const token of [...sessions.keys()]) {
    if (token !== keep) sessions.delete(token);
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function isAuthenticated(req) {
  if (!authRequired()) return true;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;

/**
 * Verifies the password; on success returns a Set-Cookie value, on failure
 * null. Throws 429 when an IP keeps failing.
 */
export function login(req, password) {
  const ip = req.socket.remoteAddress ?? 'unknown';
  // Only failures count toward the limit — a legitimate user logging in
  // repeatedly must never lock themselves out.
  if (overLimit(`login:${ip}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)) {
    throw new HttpError(429, 'too many login attempts — try again later');
  }
  if (!authRequired() || !checkPassword(password)) {
    recordHit(`login:${ip}`);
    return null;
  }
  return createSession();
}

/** Invalidates the request's session; returns a Set-Cookie value that clears it. */
export function logout(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
