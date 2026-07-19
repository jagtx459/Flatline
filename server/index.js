import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.js';
import {
  encryptSecrets, decryptSecrets, secretKeys,
  keySource, parseKeyInput, rotateKey, recoverStagedKey
} from './secrets.js';
import { startPoller, reschedule } from './poller.js';
import { startShutdownWatcher, getGroupStates } from './shutdown.js';
import { runCheck } from './checks.js';
import { testTarget, runStep, restoreStep } from './connectors.js';
import {
  startTargetHealthPoller, getTargetHealth, checkTargetNow,
  getTargetActivity, recordTargetActivity, clearTargetActivity
} from './targetHealth.js';
import {
  startNotifier, sendTest, parseChannelConfig, checkChannelSecrets,
  NOTIFY_CONFIG_FIELDS, NOTIFY_SECRET_FIELDS, getChannelResult, clearChannelResult
} from './notify.js';
import {
  HttpError, readJsonBody, hostAllowed, applySecurityHeaders,
  rateLimit, authRequired, isAuthenticated, login, logout,
  passwordSource, allowedHostsSource, hashPassword, createSession,
  resetOtherSessions, invalidateSecurityCache, parseHostList,
  crossOriginBlocked
} from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT ?? 3131);
const PKG_VERSION = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

// ---------- helpers ----------

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function intInRange(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanString(v, maxLen) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > maxLen ? '' : s;
}

/** Runs a write and converts UNIQUE-constraint violations into a 400. */
function tryWrite(res, fn) {
  try {
    return fn();
  } catch (err) {
    if (/UNIQUE constraint/i.test(err.message)) {
      sendError(res, 400, 'that name is already in use');
      return undefined;
    }
    throw err;
  }
}

// ---------- validation ----------

/** Validates an endpoint payload; returns a clean input object or a string error. */
function parseEndpointInput(body) {
  if (typeof body !== 'object' || body === null) return 'invalid body';

  const name = cleanString(body.name, 100);
  if (!name) return 'name is required (max 100 chars)';

  const type = body.type;
  if (type !== 'icmp' && type !== 'http') return "type must be 'icmp' or 'http'";

  const target = cleanString(body.target, 500);
  if (!target) return 'target is required';
  if (type === 'http') {
    try {
      const u = new URL(target);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'target must be an http(s) URL';
    } catch {
      return 'target must be a valid URL for http checks';
    }
  } else {
    // The target becomes a ping argv entry — restrict it to hostname/IP
    // characters and forbid a leading '-' so it can never be read as a flag.
    if (target.length > 253 || !/^[A-Za-z0-9:][A-Za-z0-9._:-]*$/.test(target)) {
      return 'target must be a hostname or IP address';
    }
  }

  let expect_status = null;
  if (type === 'http' && body.expect_status != null && body.expect_status !== '') {
    const n = Number(body.expect_status);
    if (!Number.isInteger(n) || n < 100 || n > 599) return 'expect_status must be an HTTP status code';
    expect_status = n;
  }

  let expect_json = null;
  if (type === 'http' && body.expect_json != null && body.expect_json !== '') {
    const raw = typeof body.expect_json === 'string' ? body.expect_json : JSON.stringify(body.expect_json);
    if (raw.length > 10_000) return 'expect_json too large (max 10000 chars)';
    try {
      expect_json = JSON.stringify(JSON.parse(raw)); // normalize
    } catch {
      return 'expect_json must be valid JSON';
    }
  }

  return {
    name,
    type,
    target,
    interval_seconds: intInRange(body.interval_seconds, 5, 86_400, 30),
    timeout_ms: intInRange(body.timeout_ms, 250, 60_000, 5000),
    down_threshold: intInRange(body.down_threshold, 1, 100, 3),
    up_threshold: intInRange(body.up_threshold, 1, 100, 2),
    expect_status,
    expect_json,
    enabled: body.enabled === undefined || body.enabled ? 1 : 0
  };
}

function parseFlatlineGroupInput(body) {
  if (typeof body !== 'object' || body === null) return 'invalid body';

  const name = cleanString(body.name, 100);
  if (!name) return 'name is required (max 100 chars)';

  const mode = body.mode ?? 'all';
  if (mode !== 'all' && mode !== 'any') return "mode must be 'all' or 'any'";

  const action_group_ids = [];
  if (body.action_group_ids !== undefined) {
    if (!Array.isArray(body.action_group_ids)) return 'action_group_ids must be an array';
    const known = new Set(store.listActionGroups().map((g) => g.id));
    for (const raw of body.action_group_ids) {
      const n = Number(raw);
      if (!Number.isInteger(n) || !known.has(n)) return 'action_group_ids contains an unknown group';
      action_group_ids.push(n);
    }
  }

  const endpoint_ids = [];
  if (body.endpoint_ids !== undefined) {
    if (!Array.isArray(body.endpoint_ids)) return 'endpoint_ids must be an array';
    const known = new Set(store.listEndpoints().map((e) => e.id));
    for (const raw of body.endpoint_ids) {
      const n = Number(raw);
      if (!Number.isInteger(n) || !known.has(n)) return 'endpoint_ids contains an unknown endpoint';
      endpoint_ids.push(n);
    }
  }

  return {
    name,
    grace_minutes: intInRange(body.grace_minutes, 1, 1440, 5),
    mode,
    enabled: body.enabled === undefined || body.enabled ? 1 : 0,
    action_group_ids,
    endpoint_ids
  };
}

// Non-secret config fields allowed per target kind. Anything not listed here
// is dropped, so secret material can never sneak into the plaintext column.
const KIND_CONFIG_FIELDS = {
  ssh:  ['host', 'port', 'username', 'auth_method', 'command', 'restore_command'],
  winrm: ['host', 'port', 'domain', 'username', 'command', 'restore_command'],
  k8s:  ['api_url', 'auth_method', 'action', 'command_method', 'command_path', 'command_body',
         'restore_method', 'restore_path', 'restore_body'],
  http: ['url', 'method', 'auth_scheme', 'header_name', 'username', 'body',
         'restore_url', 'restore_method', 'restore_body']
};

const K8S_ACTIONS = ['drain', 'custom'];
const K8S_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Secret fields allowed per kind — stored only in the encrypted blob.
// ssh's sudo_password is optional: only needed when the command uses
// `sudo -S` and the host isn't set up with passwordless sudo (preferred).
const KIND_SECRET_FIELDS = {
  ssh:  ['password', 'private_key', 'passphrase', 'sudo_password'],
  winrm: ['password'],
  k8s:  ['token', 'kubeconfig'],
  http: ['token', 'password']
};

const MAX_SECRET_LEN = 262_144; // room for kubeconfigs / private keys

function parseInfraConfig(kind, raw) {
  const src = typeof raw === 'object' && raw !== null ? raw : {};
  const cfg = {};
  for (const field of KIND_CONFIG_FIELDS[kind]) {
    const v = src[field];
    if (v === undefined || v === null || v === '') continue;
    cfg[field] = cleanString(String(v), ['body', 'command', 'command_body', 'restore_body', 'restore_command'].includes(field) ? 10_000 : 2000);
  }

  switch (kind) {
    case 'ssh': {
      if (!cfg.host) return 'host is required';
      if (!cfg.username) return 'username is required';
      cfg.port = intInRange(src.port, 1, 65_535, 22);
      if (cfg.auth_method && !['password', 'key'].includes(cfg.auth_method)) return "auth_method must be 'password' or 'key'";
      cfg.auth_method ??= 'password';
      break;
    }
    case 'winrm': {
      if (!cfg.host) return 'host is required';
      if (!cfg.username) return 'username is required';
      cfg.port = intInRange(src.port, 1, 65_535, 5985);
      break;
    }
    case 'k8s': {
      if (cfg.auth_method && !['token', 'kubeconfig'].includes(cfg.auth_method)) return "auth_method must be 'token' or 'kubeconfig'";
      cfg.auth_method ??= 'token';
      // With a kubeconfig, the server URL comes from the kubeconfig itself —
      // api_url is only required for plain bearer-token auth; for kubeconfig
      // auth it's an optional override (e.g. reaching the cluster via a
      // different network path than what's baked into the file).
      if (cfg.api_url) {
        try {
          const u = new URL(cfg.api_url);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'api_url must be http(s)';
        } catch {
          return 'api_url must be a valid URL';
        }
      } else if (cfg.auth_method === 'token') {
        return 'api_url is required';
      }
      if (cfg.action && !K8S_ACTIONS.includes(cfg.action)) return "action must be 'drain' or 'custom'";
      cfg.action ??= 'drain';
      if (cfg.action === 'custom') {
        if (!cfg.command_path) return 'command path is required for a custom action';
        if (cfg.command_method && !K8S_METHODS.includes(cfg.command_method)) return `command method must be one of ${K8S_METHODS.join('/')}`;
        cfg.command_method ??= 'PATCH';
        if (cfg.restore_method && !K8S_METHODS.includes(cfg.restore_method)) return `restore method must be one of ${K8S_METHODS.join('/')}`;
        if (cfg.restore_path) cfg.restore_method ??= 'PATCH';
      }
      break;
    }
    case 'http': {
      if (!cfg.url) return 'url is required';
      try {
        const u = new URL(cfg.url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'url must be http(s)';
      } catch {
        return 'url must be a valid URL';
      }
      if (cfg.method && !['GET', 'POST', 'PUT', 'DELETE'].includes(cfg.method)) return 'method must be GET/POST/PUT/DELETE';
      cfg.method ??= 'POST';
      if (cfg.auth_scheme && !['none', 'bearer', 'basic', 'header'].includes(cfg.auth_scheme)) {
        return "auth_scheme must be 'none', 'bearer', 'basic', or 'header'";
      }
      cfg.auth_scheme ??= 'none';
      if (cfg.auth_scheme === 'header') {
        if (!cfg.header_name) return 'header_name is required for the custom-header scheme';
        // RFC 7230 token — anything else could smuggle CR/LF into the request.
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(cfg.header_name)) {
          return 'header_name contains invalid characters';
        }
      }
      if (cfg.auth_scheme === 'basic') {
        if (!cfg.username) return 'username is required for basic auth';
        if (/[\r\n:]/.test(cfg.username)) return 'username contains invalid characters';
      }
      if (cfg.restore_url) {
        try {
          const u = new URL(cfg.restore_url);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'restore URL must be http(s)';
        } catch {
          return 'restore URL must be a valid URL';
        }
        if (cfg.restore_method && !['GET', 'POST', 'PUT', 'DELETE'].includes(cfg.restore_method)) {
          return 'restore method must be GET/POST/PUT/DELETE';
        }
        cfg.restore_method ??= 'POST';
      }
      break;
    }
  }
  return cfg;
}

/**
 * Merges submitted secret fields over the existing stored ones.
 * Per field: non-empty string replaces, null clears, absent/empty keeps —
 * so an edit form can leave credential inputs blank without wiping them.
 * `allowed` is the field whitelist for the kind (action target or channel).
 */
function mergeSecrets(allowed, existingEnc, submitted) {
  const current = existingEnc ? decryptSecrets(existingEnc) : {};
  const next = {};
  for (const field of allowed) {
    const v = submitted?.[field];
    if (typeof v === 'string' && v.length > 0) {
      if (v.length > MAX_SECRET_LEN) return `secret field '${field}' is too large`;
      next[field] = v;
    } else if (v === null) {
      // explicit clear — drop the field
    } else if (typeof current[field] === 'string') {
      next[field] = current[field];
    }
  }
  return encryptSecrets(next);
}

/**
 * Sanitizes an unsaved (draft) secrets object from a test request: only the
 * kind's allowed fields, strings only, length-capped. Returns a string error
 * when a field is too large.
 */
function pickSecrets(allowed, raw) {
  const src = typeof raw === 'object' && raw !== null ? raw : {};
  const out = {};
  for (const field of allowed) {
    const v = src[field];
    if (typeof v !== 'string' || v.length === 0) continue;
    if (v.length > MAX_SECRET_LEN) return `secret field '${field}' is too large`;
    out[field] = v;
  }
  return out;
}

/** Strips secret material before a target leaves the process. */
function publicTarget(t) {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    config: JSON.parse(t.config),
    secret_fields: secretKeys(t.secret_enc),
    enabled: t.enabled,
    created_at: t.created_at,
    health: getTargetHealth(t.id),
    last_activity: getTargetActivity(t.id)
  };
}

// ---------- internal API (consumed only by the pages in public/) ----------

const DASHBOARD_BUCKETS = 120;
const RECENT_CHECKS = 90;

// Settings keys the API may expose — auth_password_hash must never leave the
// process, even hashed.
const PUBLIC_SETTINGS = ['grace_minutes', 'retention_days', 'allowed_hosts'];

function publicSettings() {
  const all = store.getSettings();
  return Object.fromEntries(PUBLIC_SETTINGS.filter((k) => k in all).map((k) => [k, all[k]]));
}

function dashboardPayload(hours) {
  const now = Date.now();
  const fromTs = now - hours * 3_600_000;

  const endpoints = store.listEndpoints().map((ep) => {
    const history = store.bucketedHistory(ep.id, fromTs, now, DASHBOARD_BUCKETS);
    const stats = store.uptimeStats(ep.id, fromTs);
    const recent = store.recentChecks(ep.id, RECENT_CHECKS);
    const lastCheck = recent.length > 0 ? recent[recent.length - 1] : null;
    return {
      id: ep.id,
      name: ep.name,
      type: ep.type,
      target: ep.target,
      interval_seconds: ep.interval_seconds,
      group_ids: ep.group_ids,
      group_names: ep.group_names,
      enabled: ep.enabled,
      state: ep.last_state,
      last_change_ts: ep.last_change_ts,
      last_check: lastCheck,
      uptime_pct: stats.total > 0 ? (100 * (stats.ok_count ?? 0)) / stats.total : null,
      check_count: stats.total,
      history,
      recent
    };
  });

  return {
    now,
    range_hours: hours,
    settings: publicSettings(),
    groups: getGroupStates(),
    endpoints,
    events: store.listEvents(25)
  };
}

async function handleApi(req, res, url) {
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  const ip = req.socket.remoteAddress ?? 'unknown';
  if (!rateLimit(`api:${ip}`, 600, 60_000)) {
    sendError(res, 429, 'too many requests');
    return;
  }

  // The API only serves the Flatline pages: reject anything with cross-site
  // origin evidence, and require positive same-origin proof (Sec-Fetch-Site
  // or a matching Origin header — browsers send them, plain scripts don't)
  // for anything state-changing.
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (crossOriginBlocked(req, mutating)) {
    sendError(res, 403, 'API requests must come from the Flatline web UI (same-origin)');
    return;
  }

  // Mutating requests must be JSON — an HTML form can't produce that, which
  // (with the SameSite session cookie and Host check) shuts down CSRF.
  if (mutating) {
    const ctype = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'application/json') {
      sendError(res, 415, 'content-type must be application/json');
      return;
    }
  }

  // GET /api/health
  if (method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, now: Date.now() });
    return;
  }

  // GET /api/version — shown in the header on every page.
  if (method === 'GET' && url.pathname === '/api/version') {
    sendJson(res, 200, { version: PKG_VERSION });
    return;
  }

  // GET /api/auth — whether a login is required/valid (used by every page).
  if (method === 'GET' && url.pathname === '/api/auth') {
    sendJson(res, 200, { auth_required: authRequired(), authenticated: isAuthenticated(req) });
    return;
  }

  // POST /api/login
  if (method === 'POST' && url.pathname === '/api/login') {
    if (!authRequired()) { sendError(res, 400, 'authentication is not enabled (set FLATLINE_PASSWORD)'); return; }
    const body = await readJsonBody(req);
    const cookie = login(req, body.password);
    if (!cookie) { sendError(res, 401, 'wrong password'); return; }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Everything below requires a session when auth is enabled.
  if (authRequired() && !isAuthenticated(req)) {
    sendError(res, 401, 'authentication required');
    return;
  }

  // POST /api/logout
  if (method === 'POST' && url.pathname === '/api/logout') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': logout(req) });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/dashboard?hours=24
  if (method === 'GET' && url.pathname === '/api/dashboard') {
    const hours = Math.min(24 * 14, Math.max(0.25, Number(url.searchParams.get('hours') ?? 24) || 24));
    sendJson(res, 200, dashboardPayload(hours));
    return;
  }

  // POST /api/endpoints/test — runs one check against the (possibly unsaved) draft in the form
  if (parts[1] === 'endpoints' && parts[2] === 'test' && method === 'POST' && parts.length === 3) {
    const input = parseEndpointInput({ ...(await readJsonBody(req)), name: 'test' });
    if (typeof input === 'string') { sendError(res, 400, input); return; }
    const result = await runCheck(input);
    sendJson(res, 200, result);
    return;
  }

  // /api/endpoints and /api/endpoints/:id
  if (parts[1] === 'endpoints') {
    if (method === 'GET' && parts.length === 2) {
      sendJson(res, 200, store.listEndpoints());
      return;
    }
    if (method === 'POST' && parts.length === 2) {
      const input = parseEndpointInput(await readJsonBody(req));
      if (typeof input === 'string') { sendError(res, 400, input); return; }
      const created = store.createEndpoint(input);
      reschedule();
      sendJson(res, 201, created);
      return;
    }
    if (parts.length === 3) {
      const id = Number(parts[2]);
      const existing = Number.isInteger(id) ? store.getEndpoint(id) : undefined;
      if (!existing) { sendError(res, 404, 'endpoint not found'); return; }

      if (method === 'PUT') {
        const input = parseEndpointInput(await readJsonBody(req));
        if (typeof input === 'string') { sendError(res, 400, input); return; }
        const updated = store.updateEndpoint(id, input);
        reschedule();
        sendJson(res, 200, updated);
        return;
      }
      if (method === 'DELETE') {
        store.deleteEndpoint(id);
        reschedule();
        sendJson(res, 200, { deleted: id });
        return;
      }
    }
  }

  // /api/groups and /api/groups/:id  (Flatline groups)
  if (parts[1] === 'groups') {
    if (method === 'GET' && parts.length === 2) {
      sendJson(res, 200, store.listFlatlineGroups());
      return;
    }
    if (method === 'POST' && parts.length === 2) {
      const input = parseFlatlineGroupInput(await readJsonBody(req));
      if (typeof input === 'string') { sendError(res, 400, input); return; }
      const created = tryWrite(res, () => store.createFlatlineGroup(input));
      if (created) sendJson(res, 201, created);
      return;
    }
    if (parts.length === 3) {
      const id = Number(parts[2]);
      const existing = Number.isInteger(id) ? store.getFlatlineGroup(id) : undefined;
      if (!existing) { sendError(res, 404, 'group not found'); return; }

      if (method === 'PUT') {
        const input = parseFlatlineGroupInput(await readJsonBody(req));
        if (typeof input === 'string') { sendError(res, 400, input); return; }
        const updated = tryWrite(res, () => store.updateFlatlineGroup(id, input));
        if (updated) sendJson(res, 200, updated);
        return;
      }
      if (method === 'DELETE') {
        store.deleteFlatlineGroup(id);
        sendJson(res, 200, { deleted: id });
        return;
      }
    }
  }

  // POST /api/actions/targets/test — connectivity test for a saved (id) or unsaved (draft) target.
  // Doesn't run the target's configured command/action — see connectors.js testTarget() — except
  // for HTTP targets, whose action IS a specific request; there's no separate no-op to send instead.
  if (parts[1] === 'actions' && parts[2] === 'targets' && parts[3] === 'test' && method === 'POST' && parts.length === 4) {
    const body = await readJsonBody(req);
    const kind = body?.kind;
    if (!KIND_CONFIG_FIELDS[kind]) { sendError(res, 400, "kind must be 'ssh', 'winrm', 'k8s', or 'http'"); return; }
    const cfg = parseInfraConfig(kind, body.config);
    if (typeof cfg === 'string') { sendError(res, 400, cfg); return; }

    let secrets = {};
    const id = Number(body.id);
    if (Number.isInteger(id)) {
      const existing = store.getActionTarget(id);
      if (!existing) { sendError(res, 404, 'target not found'); return; }
      const baseEnc = kind === existing.kind ? existing.secret_enc : null;
      const merged = mergeSecrets(KIND_SECRET_FIELDS[kind], baseEnc, body.secrets);
      if (typeof merged === 'string' && !merged.startsWith('v1:')) { sendError(res, 400, merged); return; }
      secrets = decryptSecrets(merged);
    } else {
      secrets = pickSecrets(KIND_SECRET_FIELDS[kind], body.secrets);
      if (typeof secrets === 'string') { sendError(res, 400, secrets); return; }
    }

    const result = await testTarget(kind, cfg, secrets);
    recordTargetActivity(Number.isInteger(id) ? id : undefined, result, 'test');
    sendJson(res, 200, result);
    return;
  }

  // POST /api/actions/targets/:id/run — actually runs the target's configured command/action
  // right now, outside of any action group or grace period. The UI must confirm with the user
  // before calling this; it is real execution, not a connectivity test.
  if (parts[1] === 'actions' && parts[2] === 'targets' && parts.length === 5 && parts[4] === 'run' && method === 'POST') {
    const id = Number(parts[3]);
    const target = Number.isInteger(id) ? store.getActionTarget(id) : undefined;
    if (!target) { sendError(res, 404, 'target not found'); return; }

    let config;
    try { config = JSON.parse(target.config); } catch { config = {}; }
    const secrets = decryptSecrets(target.secret_enc);
    const result = await runStep(target.kind, config, secrets);
    recordTargetActivity(id, result, 'run');

    store.recordEvent({
      ts: Date.now(),
      kind: result.ok ? 'action_step_ok' : 'action_step_failed',
      message: `Manual run: ${target.name} (${target.kind}): ${result.message}`
    });
    sendJson(res, 200, result);
    return;
  }

  // POST /api/actions/targets/:id/restore — undoes a prior run, where that's
  // meaningful (currently k8s only — see connectors.js restoreStep()).
  if (parts[1] === 'actions' && parts[2] === 'targets' && parts.length === 5 && parts[4] === 'restore' && method === 'POST') {
    const id = Number(parts[3]);
    const target = Number.isInteger(id) ? store.getActionTarget(id) : undefined;
    if (!target) { sendError(res, 404, 'target not found'); return; }

    let config;
    try { config = JSON.parse(target.config); } catch { config = {}; }
    const secrets = decryptSecrets(target.secret_enc);
    const result = await restoreStep(target.kind, config, secrets);
    recordTargetActivity(id, result, 'restore');

    store.recordEvent({
      ts: Date.now(),
      kind: result.ok ? 'action_step_ok' : 'action_step_failed',
      message: `Manual restore: ${target.name} (${target.kind}): ${result.message}`
    });
    sendJson(res, 200, result);
    return;
  }

  // /api/actions/targets and /api/actions/targets/:id
  if (parts[1] === 'actions' && parts[2] === 'targets') {
    if (method === 'GET' && parts.length === 3) {
      sendJson(res, 200, store.listActionTargets().map(publicTarget));
      return;
    }
    if (method === 'POST' && parts.length === 3) {
      const body = await readJsonBody(req);
      const name = cleanString(body?.name, 100);
      if (!name) { sendError(res, 400, 'name is required (max 100 chars)'); return; }
      const kind = body?.kind;
      if (!KIND_CONFIG_FIELDS[kind]) { sendError(res, 400, "kind must be 'ssh', 'winrm', 'k8s', or 'http'"); return; }
      const cfg = parseInfraConfig(kind, body.config);
      if (typeof cfg === 'string') { sendError(res, 400, cfg); return; }
      const secretEnc = mergeSecrets(KIND_SECRET_FIELDS[kind], null, body.secrets);
      if (typeof secretEnc === 'string' && !secretEnc.startsWith('v1:')) { sendError(res, 400, secretEnc); return; }
      const created = store.createActionTarget({
        name, kind, config: JSON.stringify(cfg), secret_enc: secretEnc,
        enabled: body.enabled === undefined || body.enabled ? 1 : 0
      });
      void checkTargetNow(created.id);
      sendJson(res, 201, publicTarget(created));
      return;
    }
    if (parts.length === 4) {
      const id = Number(parts[3]);
      const existing = Number.isInteger(id) ? store.getActionTarget(id) : undefined;
      if (!existing) { sendError(res, 404, 'target not found'); return; }

      if (method === 'PUT') {
        const body = await readJsonBody(req);
        const name = cleanString(body?.name, 100);
        if (!name) { sendError(res, 400, 'name is required (max 100 chars)'); return; }
        const kind = body?.kind;
        if (!KIND_CONFIG_FIELDS[kind]) { sendError(res, 400, "kind must be 'ssh', 'winrm', 'k8s', or 'http'"); return; }
        const cfg = parseInfraConfig(kind, body.config);
        if (typeof cfg === 'string') { sendError(res, 400, cfg); return; }
        // Changing kind invalidates old secrets (different field set).
        const baseEnc = kind === existing.kind ? existing.secret_enc : null;
        const secretEnc = mergeSecrets(KIND_SECRET_FIELDS[kind], baseEnc, body.secrets);
        if (typeof secretEnc === 'string' && !secretEnc.startsWith('v1:')) { sendError(res, 400, secretEnc); return; }
        const updated = store.updateActionTarget(id, {
          name, kind, config: JSON.stringify(cfg), secret_enc: secretEnc,
          enabled: body.enabled === undefined || body.enabled ? 1 : 0
        });
        void checkTargetNow(updated.id);
        sendJson(res, 200, publicTarget(updated));
        return;
      }
      if (method === 'DELETE') {
        store.deleteActionTarget(id);
        clearTargetActivity(id);
        sendJson(res, 200, { deleted: id });
        return;
      }
    }
  }

  // /api/actions/groups and /api/actions/groups/:id
  if (parts[1] === 'actions' && parts[2] === 'groups') {
    if (method === 'GET' && parts.length === 3) {
      sendJson(res, 200, store.listActionGroups());
      return;
    }
    if (method === 'POST' && parts.length === 3) {
      const body = await readJsonBody(req);
      const input = parseActionGroupInput(body);
      if (typeof input === 'string') { sendError(res, 400, input); return; }
      const created = tryWrite(res, () => store.createActionGroup(input));
      if (created) sendJson(res, 201, created);
      return;
    }
    if (parts.length === 4) {
      const id = Number(parts[3]);
      const existing = Number.isInteger(id) ? store.getActionGroup(id) : undefined;
      if (!existing) { sendError(res, 404, 'group not found'); return; }

      if (method === 'PUT') {
        const input = parseActionGroupInput(await readJsonBody(req));
        if (typeof input === 'string') { sendError(res, 400, input); return; }
        const updated = tryWrite(res, () => store.updateActionGroup(id, input));
        if (updated) sendJson(res, 200, updated);
        return;
      }
      if (method === 'DELETE') {
        store.deleteActionGroup(id);
        sendJson(res, 200, { deleted: id });
        return;
      }
    }
  }

  // GET /api/events?limit=50
  if (method === 'GET' && url.pathname === '/api/events') {
    const limit = intInRange(url.searchParams.get('limit'), 1, 500, 50);
    sendJson(res, 200, store.listEvents(limit));
    return;
  }

  // ---- encryption key management ----

  // GET /api/config/key — where the key comes from (never the key itself).
  if (method === 'GET' && url.pathname === '/api/config/key') {
    sendJson(res, 200, {
      source: keySource(),
      encrypted_items: store.allEncryptedRows().length
    });
    return;
  }

  // POST /api/config/key/rotate — generate a fresh key and re-encrypt
  // everything (file-based keys only; env keys must be set explicitly).
  // PUT /api/config/key — re-encrypt everything under a caller-supplied key.
  if (url.pathname === '/api/config/key/rotate' && method === 'POST') {
    return handleKeyChange(res, null);
  }
  if (url.pathname === '/api/config/key' && method === 'PUT') {
    const body = await readJsonBody(req);
    const key = parseKeyInput(body.key);
    if (!key) { sendError(res, 400, 'key must be 32 bytes, encoded as 64 hex chars or base64'); return; }
    return handleKeyChange(res, key);
  }

  // ---- notification channels ----

  // POST /api/notifications/test — test a saved (id) or unsaved (draft) channel.
  if (url.pathname === '/api/notifications/test' && method === 'POST') {
    const body = await readJsonBody(req);
    const kind = body?.kind;
    if (!NOTIFY_CONFIG_FIELDS[kind]) { sendError(res, 400, 'unknown channel kind'); return; }
    const cfg = parseChannelConfig(kind, body.config, body.config?.events, body.config);
    if (typeof cfg === 'string') { sendError(res, 400, cfg); return; }

    let secrets;
    const id = Number(body.id);
    if (Number.isInteger(id)) {
      const existing = store.getNotificationChannel(id);
      if (!existing) { sendError(res, 404, 'channel not found'); return; }
      const baseEnc = kind === existing.kind ? existing.secret_enc : null;
      const merged = mergeSecrets(NOTIFY_SECRET_FIELDS[kind], baseEnc, body.secrets);
      if (typeof merged === 'string' && !merged.startsWith('v1:')) { sendError(res, 400, merged); return; }
      secrets = decryptSecrets(merged);
    } else {
      secrets = pickSecrets(NOTIFY_SECRET_FIELDS[kind], body.secrets);
      if (typeof secrets === 'string') { sendError(res, 400, secrets); return; }
    }
    const secretErr = checkChannelSecrets(kind, cfg, secrets);
    if (secretErr) { sendError(res, 400, secretErr); return; }

    sendJson(res, 200, await sendTest(kind, cfg, secrets, Number.isInteger(id) ? id : undefined));
    return;
  }

  // /api/notifications and /api/notifications/:id
  if (parts[1] === 'notifications') {
    if (method === 'GET' && parts.length === 2) {
      sendJson(res, 200, store.listNotificationChannels().map(publicChannel));
      return;
    }
    if (method === 'POST' && parts.length === 2) {
      const body = await readJsonBody(req);
      const input = parseNotificationInput(body, null);
      if (typeof input === 'string') { sendError(res, 400, input); return; }
      sendJson(res, 201, publicChannel(store.createNotificationChannel(input)));
      return;
    }
    if (parts.length === 3) {
      const id = Number(parts[2]);
      const existing = Number.isInteger(id) ? store.getNotificationChannel(id) : undefined;
      if (!existing) { sendError(res, 404, 'channel not found'); return; }

      if (method === 'PUT') {
        const input = parseNotificationInput(await readJsonBody(req), existing);
        if (typeof input === 'string') { sendError(res, 400, input); return; }
        sendJson(res, 200, publicChannel(store.updateNotificationChannel(id, input)));
        return;
      }
      if (method === 'DELETE') {
        store.deleteNotificationChannel(id);
        clearChannelResult(id);
        sendJson(res, 200, { deleted: id });
        return;
      }
    }
  }

  // ---- site security config (password + allowed hosts) ----

  // GET /api/config/security — where the password/host allowlist come from.
  if (method === 'GET' && url.pathname === '/api/config/security') {
    sendJson(res, 200, {
      password_source: passwordSource(),               // 'env' | 'settings' | null
      allowed_hosts_source: allowedHostsSource(),      // 'env' | 'settings'
      allowed_hosts: allowedHostsSource() === 'env'
        ? (process.env.FLATLINE_ALLOWED_HOSTS ?? '')
        : (store.getSettings().allowed_hosts ?? '')
    });
    return;
  }

  // PUT /api/config/password — set/change the site password (settings mode).
  if (method === 'PUT' && url.pathname === '/api/config/password') {
    if (passwordSource() === 'env') {
      sendError(res, 400, 'the password is set via FLATLINE_PASSWORD — change it there');
      return;
    }
    const body = await readJsonBody(req);
    const pw = body.password;
    if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) {
      sendError(res, 400, 'password must be 8-200 characters');
      return;
    }
    store.setSetting('auth_password_hash', hashPassword(pw));
    invalidateSecurityCache();
    resetOtherSessions(req);
    store.recordEvent({ ts: Date.now(), kind: 'auth_changed', message: 'Site password set/changed from the config page' });
    // Issue a session so the requester stays logged in when enabling auth.
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': createSession() });
    res.end(JSON.stringify({ ok: true, note: 'Password set — a login is now required on every page.' }));
    return;
  }

  // DELETE /api/config/password — turn the login requirement back off.
  if (method === 'DELETE' && url.pathname === '/api/config/password') {
    if (passwordSource() === 'env') {
      sendError(res, 400, 'the password is set via FLATLINE_PASSWORD — unset the environment variable instead');
      return;
    }
    store.setSetting('auth_password_hash', '');
    invalidateSecurityCache();
    store.recordEvent({ ts: Date.now(), kind: 'auth_changed', message: 'Site password removed from the config page — login no longer required' });
    sendJson(res, 200, { ok: true, note: 'Password removed — the UI and API are open again.' });
    return;
  }

  // GET/PUT /api/settings
  if (url.pathname === '/api/settings') {
    if (method === 'GET') {
      sendJson(res, 200, publicSettings());
      return;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      if (typeof body !== 'object' || body === null) { sendError(res, 400, 'invalid body'); return; }
      if (body.retention_days !== undefined) {
        const n = Number(body.retention_days);
        if (!Number.isFinite(n) || n < 1 || n > 14) { sendError(res, 400, 'retention_days must be 1-14'); return; }
        store.setSetting('retention_days', Math.round(n));
      }
      if (body.allowed_hosts !== undefined) {
        if (allowedHostsSource() === 'env') {
          sendError(res, 400, 'allowed hosts are set via FLATLINE_ALLOWED_HOSTS — change them there');
          return;
        }
        if (typeof body.allowed_hosts !== 'string' || body.allowed_hosts.length > 2000) {
          sendError(res, 400, 'allowed_hosts must be a comma-separated string');
          return;
        }
        const hosts = [...parseHostList(body.allowed_hosts)];
        for (const h of hosts) {
          if (h.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h)) {
            sendError(res, 400, `invalid hostname: ${h.slice(0, 80)}`);
            return;
          }
        }
        if (hosts.length > 20) { sendError(res, 400, 'at most 20 allowed hosts'); return; }
        store.setSetting('allowed_hosts', hosts.join(','));
        invalidateSecurityCache();
      }
      sendJson(res, 200, publicSettings());
      return;
    }
  }

  sendError(res, 404, 'not found');
}

function parseActionGroupInput(body) {
  if (typeof body !== 'object' || body === null) return 'invalid body';

  const name = cleanString(body.name, 100);
  if (!name) return 'name is required (max 100 chars)';

  const on_failure = body.on_failure ?? 'continue';
  if (on_failure !== 'continue' && on_failure !== 'stop') {
    return "on_failure must be 'continue' (run remaining steps) or 'stop' (abort the sequence)";
  }

  const steps = [];
  if (body.steps !== undefined) {
    if (!Array.isArray(body.steps)) return 'steps must be an array';
    const known = new Set(store.listActionTargets().map((t) => t.id));
    const seen = new Set();
    for (const raw of body.steps) {
      const n = Number(raw?.target_id);
      if (!Number.isInteger(n) || !known.has(n)) return 'steps contains an unknown target';
      if (seen.has(n)) return 'steps contains the same target twice';
      seen.add(n);
      steps.push({ target_id: n, timeout_seconds: intInRange(raw?.timeout_seconds, 5, 3600, 60) });
    }
  }

  return { name, on_failure, steps, enabled: body.enabled === undefined || body.enabled ? 1 : 0 };
}

/** Rotates or sets the encryption key, re-encrypting every stored blob. */
function handleKeyChange(res, newKey) {
  try {
    const result = rotateKey(newKey, (reencrypt) => {
      const rows = store.allEncryptedRows().map((r) => ({ ...r, secret_enc: reencrypt(r.secret_enc) }));
      store.updateEncryptedRows(rows);
    });
    store.recordEvent({ ts: Date.now(), kind: 'key_rotated', message: 'Encryption key changed — all stored credentials re-encrypted' });
    sendJson(res, 200, {
      ok: true,
      source: result.source,
      note: result.source === 'env'
        ? 'Re-encrypted with the new key. Update FLATLINE_SECRET_KEY to this key NOW — the old value will no longer decrypt anything after the next restart.'
        : `${result.generated ? 'New key generated and saved to' : 'Provided key saved to'} the key file. Back it up — without it stored credentials are unrecoverable.`
    });
  } catch (err) {
    sendError(res, 400, err.message);
  }
}

/** Validates a notification-channel payload; returns row values or a string error. */
function parseNotificationInput(body, existing) {
  if (typeof body !== 'object' || body === null) return 'invalid body';

  const name = cleanString(body.name, 100);
  if (!name) return 'name is required (max 100 chars)';

  const kind = body.kind;
  if (!NOTIFY_CONFIG_FIELDS[kind]) return "kind must be 'webhook', 'discord', 'ntfy', or 'email'";

  const cfg = parseChannelConfig(kind, body.config, body.config?.events, body.config);
  if (typeof cfg === 'string') return cfg;

  // Changing kind invalidates old secrets (different field set).
  const baseEnc = existing && kind === existing.kind ? existing.secret_enc : null;
  const secretEnc = mergeSecrets(NOTIFY_SECRET_FIELDS[kind], baseEnc, body.secrets);
  if (typeof secretEnc === 'string' && !secretEnc.startsWith('v1:')) return secretEnc;

  const secretErr = checkChannelSecrets(kind, cfg, decryptSecrets(secretEnc));
  if (secretErr) return secretErr;

  return {
    name,
    kind,
    config: JSON.stringify(cfg),
    secret_enc: secretEnc,
    enabled: body.enabled === undefined || body.enabled ? 1 : 0
  };
}

/** Strips secret material before a channel leaves the process. */
function publicChannel(c) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    config: JSON.parse(c.config),
    secret_fields: secretKeys(c.secret_enc),
    enabled: c.enabled,
    created_at: c.created_at,
    last_result: getChannelResult(c.id)
  };
}

// ---------- static files ----------

const PAGE_ROUTES = {
  '/': '/index.html',
  '/flatline': '/flatline.html',
  '/actions': '/actions.html',
  '/config': '/config.html',
  '/login': '/login.html'
};

async function handleStatic(req, res, pathname) {
  // When auth is enabled, pages redirect to/away from the login screen.
  // Assets (css/js/logo) stay open so the login page itself can render —
  // they contain no data; everything sensitive is behind the API gate.
  if (pathname in PAGE_ROUTES && authRequired()) {
    const authed = isAuthenticated(req);
    if (pathname === '/login' && authed) {
      res.writeHead(302, { location: '/' });
      res.end();
      return;
    }
    if (pathname !== '/login' && !authed) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }
  }

  const rel = PAGE_ROUTES[pathname] ?? pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    sendError(res, 403, 'forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    sendError(res, 404, 'not found');
  }
}

// ---------- server ----------

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);

  if ((req.url ?? '').length > 2048) {
    sendError(res, 414, 'URI too long');
    return;
  }
  // DNS-rebinding guard: only serve requests addressed to us (IP literal,
  // localhost, or an FLATLINE_ALLOWED_HOSTS entry) — see security.js.
  if (!hostAllowed(req.headers.host)) {
    sendError(res, 403, 'unrecognized Host header (set FLATLINE_ALLOWED_HOSTS to allow a hostname)');
    return;
  }

  let url;
  let pathname;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendError(res, 400, 'bad request');
    return;
  }

  const handler = pathname.startsWith('/api/')
    ? handleApi(req, res, url)
    : handleStatic(req, res, pathname);

  handler.catch((err) => {
    if (err instanceof HttpError) {
      if (!res.headersSent) sendError(res, err.status, err.message);
      else res.end();
      return;
    }
    console.error('[http] handler error:', err);
    if (!res.headersSent) sendError(res, 500, 'internal error');
    else res.end();
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is another Flatline instance running? ` +
      `Stop it, or pick a different port with the PORT environment variable.`);
    process.exit(1);
  }
  throw err;
});

// Self-heal from a key rotation interrupted between the DB rewrite and the
// key-file rename (probes stored ciphertexts against the staged key).
recoverStagedKey(store.allEncryptedRows().map((r) => r.secret_enc));

server.listen(PORT, () => {
  console.log(`Flatline listening on http://localhost:${PORT}`);
  if (!authRequired()) {
    console.log('[auth] no FLATLINE_PASSWORD set — the UI and API are open to anyone who can reach this port');
  }
  startPoller();
  startShutdownWatcher();
  startTargetHealthPoller();
  startNotifier();

  // Retention pruning: hourly, using the configured retention window.
  const prune = () => {
    const days = Number(store.getSettings().retention_days ?? '30');
    store.pruneHistory(Date.now() - days * 86_400_000);
  };
  prune();
  setInterval(prune, 3_600_000);
});
