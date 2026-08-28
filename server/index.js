import http from 'node:http';
import { readFileSync, createWriteStream, readdirSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.js';
import {
  encryptSecrets, decryptSecrets, secretKeys,
  keySource, parseKeyInput, rotateKey, recoverStagedKey
} from './secrets.js';
import { startPoller, reschedule } from './poller.js';
import { startShutdownWatcher, getGroupStates, evaluateNow } from './shutdown.js';
import {
  startActionGroupRun, pauseRun, resumeRun, cancelRun, isRunning,
  markInterruptedRuns, publicRun
} from './actionRuns.js';
import { runCheck } from './checks.js';
import { intInRange, cleanString } from './inputs.js';
import {
  KIND_CONFIG_FIELDS, MAX_SECRET_LEN, secretFieldsFor,
  RELAY_KINDS, RELAY_SECRET_FIELDS,
  parseInfraConfig, parseRelayConfig, parseRelayNetwork, parseWakeCommand, isSequenceRestore
} from './targetConfig.js';
import { testTarget, runStep, restoreStep } from './connectors.js';
import { resolveWakeRelay } from './autoRestore.js';
import {
  startTargetHealthPoller, getTargetHealth, checkTargetNow,
  getTargetActivity, recordTargetActivity, clearTargetActivity,
  getRestoreProgress, beginRestore, endRestore, isRestoring,
  setWatched, onHealthChange
} from './targetHealth.js';
import {
  startNotifier, sendTest, parseChannelConfig, checkChannelSecrets,
  NOTIFY_CONFIG_FIELDS, NOTIFY_SECRET_FIELDS, getChannelResult, clearChannelResult,
  baseUrl, baseUrlSource
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
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const PORT = Number(process.env.PORT ?? 3131);
const PKG_VERSION = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
// Config imports can carry many large encrypted secrets (kubeconfigs, keys), so
// this route gets a roomier body cap than the default 1 MB — still bounded.
const IMPORT_MAX_BYTES = 25 * 1024 * 1024;

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

// Best encoding the client accepts, in our order of preference (brotli beats
// gzip on text and matters most over a slow VPN link). Returns null for none.
function pickEncoding(acceptEncoding) {
  const ae = String(acceptEncoding ?? '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

// Compressing responses below ~1 KB costs more in headers/CPU than it saves.
const COMPRESS_MIN_BYTES = 1024;

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  const enc = Buffer.byteLength(json) >= COMPRESS_MIN_BYTES
    ? pickEncoding(res.req?.headers['accept-encoding'])
    : null;
  if (enc) {
    // Bounded brotli quality: full-quality br on every dynamic response would
    // burn CPU for little extra ratio; 5 is a good latency/size trade.
    const data = enc === 'br'
      ? zlib.brotliCompressSync(json, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
      : zlib.gzipSync(json);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': enc,
      vary: 'Accept-Encoding'
    });
    res.end(data);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
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

/**
 * Merges submitted secret fields over the existing stored ones.
 * Per field: non-empty string replaces, null clears, absent/empty keeps —
 * so an edit form can leave credential inputs blank without wiping them.
 * `allowed` is the field whitelist for the kind (action target or channel).
 *
 * Returns { enc } or { error } — the two cannot be told apart from a bare
 * string, since the ciphertext is one too.
 */
function mergeSecrets(allowed, existingEnc, submitted) {
  const current = existingEnc ? decryptSecrets(existingEnc) : {};
  const next = {};
  for (const field of allowed) {
    const v = submitted?.[field];
    if (typeof v === 'string' && v.length > 0) {
      if (v.length > MAX_SECRET_LEN) return { error: `secret field '${field}' is too large` };
      next[field] = v;
    } else if (v === null) {
      // explicit clear — drop the field
    } else if (typeof current[field] === 'string') {
      next[field] = current[field];
    }
  }
  return { enc: encryptSecrets(next) };
}

/**
 * Sanitizes an unsaved (draft) secrets object from a test request: only the
 * kind's allowed fields, strings only, length-capped.
 * Returns { secrets } or { error }.
 */
function pickSecrets(allowed, raw) {
  const src = typeof raw === 'object' && raw !== null ? raw : {};
  const out = {};
  for (const field of allowed) {
    const v = src[field];
    if (typeof v !== 'string' || v.length === 0) continue;
    if (v.length > MAX_SECRET_LEN) return { error: `secret field '${field}' is too large` };
    out[field] = v;
  }
  return { secrets: out };
}

/**
 * The plaintext credentials a /test request should run with. A saved entity
 * keeps its stored credentials where the form left the inputs blank; an unsaved
 * draft can only use what was submitted. `baseEnc` is the stored blob to merge
 * over, or null when there is nothing to inherit (a draft, or a kind change —
 * a different kind has a different field set).
 *
 * Returns { secrets } or { error }.
 */
function resolveSecrets(allowed, baseEnc, submitted, isSaved) {
  if (!isSaved) return pickSecrets(allowed, submitted);
  const merged = mergeSecrets(allowed, baseEnc, submitted);
  if (merged.error) return merged;
  return { secrets: decryptSecrets(merged.enc) };
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
    last_activity: getTargetActivity(t.id),
    restore_progress: getRestoreProgress(t.id)
  };
}

/** Strips secret material before a relay leaves the process. */
function publicRelay(r) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    config: JSON.parse(r.config),
    wake_command: r.wake_command,
    network: r.network,
    secret_fields: secretKeys(r.secret_enc),
    enabled: r.enabled,
    created_at: r.created_at
  };
}

// ---------- internal API (consumed only by the pages in public/) ----------

const DASHBOARD_BUCKETS = 120;
const RECENT_CHECKS = 90;
const DASHBOARD_RUNS = 10;

// Settings keys the API may expose — auth_password_hash must never leave the
// process, even hashed.
const PUBLIC_SETTINGS = ['grace_minutes', 'retention_days', 'allowed_hosts', 'base_url'];

function publicSettings() {
  const all = store.getSettings();
  const out = Object.fromEntries(PUBLIC_SETTINGS.filter((k) => k in all).map((k) => [k, all[k]]));
  // The env var wins over the stored value, so report both what applies and
  // where it came from — the config page shows the field read-only for 'env'.
  out.base_url_source = baseUrlSource();
  out.base_url = baseUrl();
  return out;
}

/**
 * Action groups as the dashboard's left-hand list wants them: how many of the
 * targets the group actually runs are reachable right now (same background
 * health poll the Actions page dots use), plus when it last ran.
 */
function actionGroupSummaries() {
  const targets = store.listActionTargets();
  const flatlineGroups = store.listFlatlineGroups();
  const lastRuns = store.lastActionRunByGroup();

  return store.listActionGroups().map((g) => {
    // Wait steps have no target, so they count towards nothing here.
    const ids = [...new Set(g.stages.flatMap((st) => st.steps.map((s) => s.target_id).filter((id) => id != null)))];
    const members = ids.map((id) => targets.find((t) => t.id === id)).filter(Boolean);
    const enabledMembers = members.filter((t) => t.enabled);
    const lastRun = lastRuns.find((r) => r.action_group_id === g.id);
    return {
      id: g.id,
      name: g.name,
      enabled: !!g.enabled,
      stage_count: g.stages.length,
      target_total: members.length,
      target_up: enabledMembers.filter((t) => getTargetHealth(t.id)?.ok === true).length,
      target_down: enabledMembers.filter((t) => getTargetHealth(t.id)?.ok === false).length,
      target_disabled: members.length - enabledMembers.length,
      flatline_group_names: flatlineGroups.filter((fg) => fg.action_group_ids.includes(g.id)).map((fg) => fg.name),
      last_run: lastRun ? { status: lastRun.status, started_at: lastRun.started_at } : null
    };
  });
}

/**
 * The history charts, memoised on the cadence at which they can actually change.
 *
 * bucketedHistory is the only expensive query on this payload — it scans every
 * check in the range, for every endpoint, and the dashboard polls every ten
 * seconds. Its answer only moves when the clock crosses into a new bucket,
 * which on the 14-day range is nearly three hours apart, so recomputing it per
 * poll was work thrown away. Keyed by endpoint, range, and which bucket-width
 * slot the clock is in: short ranges have small buckets and still recompute
 * often, long ones barely recompute at all, which is where the cost was.
 *
 * The cost of that is a chart whose right-hand edge can trail the clock by up
 * to one bucket: ~30s on the 1h range, ~12 min on 24h, ~2.8h on 14d. Only the
 * charts and the uptime figure are affected. Everything the page alerts on —
 * endpoint state, the recent-checks strip, group states, runs, events — is read
 * fresh on every poll and never served from here, so an outage still shows up
 * within one refresh however long the selected range is.
 *
 * To trade some of the saving back for a tighter edge, cap the slot width:
 * Math.min(bucketWidthMs(...), 60_000) bounds the lag at a minute on every
 * range, at the cost of recomputing the long ranges once a minute.
 */
const historyCache = new Map(); // `${endpointId}:${hours}` -> { slot, history }

function cachedHistory(endpointId, hours, fromTs, now) {
  const slot = Math.floor(now / store.bucketWidthMs(fromTs, now, DASHBOARD_BUCKETS));
  const key = `${endpointId}:${hours}`;
  const hit = historyCache.get(key);
  if (hit && hit.slot === slot) return hit.history;

  const history = store.bucketedHistory(endpointId, fromTs, now, DASHBOARD_BUCKETS);
  // One entry per endpoint and range: a new slot replaces its predecessor
  // rather than accumulating beside it, so the map stays the size of the
  // endpoint list times the five ranges.
  historyCache.set(key, { slot, history });
  return history;
}

function dashboardPayload(hours) {
  const now = Date.now();
  const fromTs = now - hours * 3_600_000;

  const endpoints = store.listEndpoints().map((ep) => {
    const history = cachedHistory(ep.id, hours, fromTs, now);
    // The buckets already count every check in the range, so uptime is summed
    // from them rather than asking the database to scan the same rows again.
    let total = 0;
    let okCount = 0;
    for (const b of history.buckets) {
      total += b.total;
      okCount += b.ok_count ?? 0;
    }
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
      uptime_pct: total > 0 ? (100 * okCount) / total : null,
      check_count: total,
      history,
      recent
    };
  });

  return {
    now,
    range_hours: hours,
    settings: publicSettings(),
    groups: getGroupStates(),
    action_groups: actionGroupSummaries(),
    action_runs: store.listActionRuns(DASHBOARD_RUNS).map(publicRun),
    endpoints,
    events: store.listEvents(25)
  };
}

// ---------- live updates ----------

/**
 * Open event streams, one per page that is watching.
 *
 * The pages poll on a timer, but a timer is a floor, not a deadline: an armed
 * or triggered group would sit unseen for the rest of the interval, which is
 * the wrong behaviour for the one thing this application exists to tell you
 * about. So every recorded event pings the open pages and they refresh on the
 * spot.
 *
 * The ping deliberately carries no data. The pages already know how to fetch
 * their own payload, and sending one here would be a second copy of the
 * dashboard route, free to drift from the first.
 */
const streamClients = new Set();
const STREAM_HEARTBEAT_MS = 25_000;
// A burst — a dozen endpoints failing together, or a group arming off the back
// of one — should wake a page once, not a dozen times.
const STREAM_COALESCE_MS = 250;

function openEventStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // Asks a buffering proxy to pass each chunk through as it is written.
    'x-accel-buffering': 'no'
  });
  res.write(': connected\n\n');
  streamClients.add(res);
  // An open stream is the signal that someone is looking, which is what puts the
  // target health poller on its fast cadence. Both pages that open one show
  // health: the dots on Actions, the up/down counts on the dashboard.
  setWatched(true);

  // Proxies close connections that go quiet; a comment line costs nothing and
  // keeps this one open through an idle night.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), STREAM_HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    streamClients.delete(res);
    setWatched(streamClients.size > 0);
  });
}

let pushTimer = null;
function pushChange() {
  if (pushTimer !== null || streamClients.size === 0) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    for (const res of streamClients) res.write('event: change\ndata: 1\n\n');
  }, STREAM_COALESCE_MS);
}

// A dot changing colour is not an event in the log, but it is a reason to
// redraw — so it reaches the pages the same way everything else does.
onHealthChange(pushChange);

store.onEvent(function liveUpdateOnEvent(ev) {
  // An endpoint flipping is what arms or disarms a group, and the watcher would
  // otherwise not look again for another five seconds. Evaluating here means
  // the group state the ping announces is already the current one.
  if (ev.kind === 'state') evaluateNow();
  pushChange();
});

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
  // (with the SameSite session cookie and Host check) shuts down CSRF. The DB
  // restore upload is the one exception (it streams a binary file); same-origin
  // is still enforced above, so CSRF is still covered.
  if (mutating && url.pathname !== '/api/config/restore') {
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

  // POST /api/actions/targets/test — connectivity test for a saved (id) or unsaved (draft) target.
  // Doesn't run the target's configured command/action — see connectors.js testTarget() — except
  // for HTTP targets, whose action IS a specific request; there's no separate no-op to send instead.
  if (parts[1] === 'actions' && parts[2] === 'targets' && parts[3] === 'test' && method === 'POST' && parts.length === 4) {
    const body = await readJsonBody(req);
    const kind = body?.kind;
    if (!KIND_CONFIG_FIELDS[kind]) { sendError(res, 400, "kind must be 'ssh', 'winrm', 'k8s', or 'http'"); return; }
    const cfg = parseInfraConfig(kind, body.config);
    if (typeof cfg === 'string') { sendError(res, 400, cfg); return; }

    const id = Number(body.id);
    const isSaved = Number.isInteger(id);
    let existing;
    if (isSaved) {
      existing = store.getActionTarget(id);
      if (!existing) { sendError(res, 404, 'target not found'); return; }
    }
    const resolved = resolveSecrets(
      secretFieldsFor(kind, cfg),
      existing && kind === existing.kind ? existing.secret_enc : null,
      body.secrets, isSaved
    );
    if (resolved.error) { sendError(res, 400, resolved.error); return; }

    const result = await testTarget(kind, cfg, resolved.secrets);
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

  // POST /api/actions/targets/:id/restore — brings a target back by running the
  // restore its owner configured: the restore step, a wait, then an optional
  // post-restore action.
  //
  // Most of those open by waiting — for a host to boot, for a cluster's API
  // server to answer, or for an http target's login to — which can take minutes,
  // so they are started and left to run rather than held open: the response says
  // it began, and the outcome lands in the target's last activity and the event
  // feed, both of which the actions page is already polling. While it runs, GET
  // on the same path reports which part of the sequence it is on.
  if (parts[1] === 'actions' && parts[2] === 'targets' && parts.length === 5 && parts[4] === 'restore' && method === 'GET') {
    const id = Number(parts[3]);
    if (!Number.isInteger(id) || !store.getActionTarget(id)) { sendError(res, 404, 'target not found'); return; }
    sendJson(res, 200, { running: isRestoring(id), progress: getRestoreProgress(id), last_activity: getTargetActivity(id) });
    return;
  }

  if (parts[1] === 'actions' && parts[2] === 'targets' && parts.length === 5 && parts[4] === 'restore' && method === 'POST') {
    const id = Number(parts[3]);
    const target = Number.isInteger(id) ? store.getActionTarget(id) : undefined;
    if (!target) { sendError(res, 404, 'target not found'); return; }
    if (isRestoring(id)) { sendError(res, 409, 'a restore is already running for this target'); return; }

    let config;
    try { config = JSON.parse(target.config); } catch { config = {}; }
    const secrets = decryptSecrets(target.secret_enc);

    const record = (result) => {
      recordTargetActivity(id, result, 'restore');
      store.recordEvent({
        ts: Date.now(),
        kind: result.ok ? 'action_step_ok' : 'action_step_failed',
        message: `Manual restore: ${target.name} (${target.kind}): ${result.message}`
      });
    };

    if (isSequenceRestore(target.kind, config)) {
      const onPhase = beginRestore(id);
      void restoreStep(target.kind, config, secrets, undefined, resolveWakeRelay(config), onPhase)
        .catch((err) => ({ ok: false, message: err.message }))
        .then((result) => { endRestore(id); record(result); });
      sendJson(res, 202, {
        ok: true, started: true,
        message: `Restore sequence started for ${target.name}. It can take a few minutes — its progress shows on this target's row.`
      });
      return;
    }

    const result = await restoreStep(target.kind, config, secrets);
    record(result);
    sendJson(res, 200, result);
    return;
  }

  // POST /api/actions/groups/:id/run — runs the whole action group now, outside any
  // Flatline group or grace period. Real execution; the UI confirms first.
  if (parts[1] === 'actions' && parts[2] === 'groups' && parts.length === 5 && parts[4] === 'run' && method === 'POST') {
    const id = Number(parts[3]);
    const group = Number.isInteger(id) ? store.getActionGroup(id) : undefined;
    if (!group) { sendError(res, 404, 'action group not found'); return; }
    if (isRunning(id)) { sendError(res, 409, `"${group.name}" is already running`); return; }

    // startActionGroupRun records the action_run_started event itself.
    const { run } = startActionGroupRun(group, { trigger: 'manual', detail: 'started from the dashboard' });
    sendJson(res, 202, publicRun(store.getActionRun(run.id)));
    return;
  }

  // POST /api/actions/runs/:id/(pause|resume|cancel) — steer a live run. The
  // run list itself rides along on the dashboard payload.
  if (parts[1] === 'actions' && parts[2] === 'runs') {
    if (method === 'POST' && parts.length === 5) {
      const id = Number(parts[3]);
      const run = Number.isInteger(id) ? store.getActionRun(id) : undefined;
      if (!run) { sendError(res, 404, 'run not found'); return; }

      const control = { pause: pauseRun, resume: resumeRun, cancel: cancelRun }[parts[4]];
      if (!control) { sendError(res, 404, 'unknown run control'); return; }

      const problem = control(id);
      if (problem) { sendError(res, 409, problem); return; }
      sendJson(res, 200, publicRun(store.getActionRun(id)));
      return;
    }
  }

  // POST /api/relays/test — prove a relay's credentials/reachability. The same
  // safe connectivity check the action targets use; it never runs the wake
  // command, which would actually power a machine on.
  if (url.pathname === '/api/relays/test' && method === 'POST') {
    const body = await readJsonBody(req);
    const kind = body?.kind;
    if (!RELAY_KINDS.includes(kind)) { sendError(res, 400, "kind must be 'ssh' or 'winrm'"); return; }
    const cfg = parseRelayConfig(kind, body.config);
    if (typeof cfg === 'string') { sendError(res, 400, cfg); return; }

    const id = Number(body.id);
    const isSaved = Number.isInteger(id);
    let existing;
    if (isSaved) {
      existing = store.getRelay(id);
      if (!existing) { sendError(res, 404, 'relay not found'); return; }
    }
    const resolved = resolveSecrets(
      RELAY_SECRET_FIELDS[kind],
      existing && kind === existing.kind ? existing.secret_enc : null,
      body.secrets, isSaved
    );
    if (resolved.error) { sendError(res, 400, resolved.error); return; }

    sendJson(res, 200, await testTarget(kind, cfg, resolved.secrets));
    return;
  }

  // GET /api/stream — server-sent events: a bare "something changed" ping, so a
  // page reacts to an outage as it happens rather than on its next poll.
  if (method === 'GET' && url.pathname === '/api/stream') {
    openEventStream(req, res);
    return;
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

  // ---- backup / restore & config transfer ----

  // GET /api/config/export — the portable config as JSON (secrets stay encrypted).
  if (method === 'GET' && url.pathname === '/api/config/export') {
    sendJson(res, 200, { flatline_config: 1, exported_at: Date.now(), ...store.exportConfig() });
    return;
  }

  // POST /api/config/import — replace ALL config from an exported JSON file.
  if (method === 'POST' && url.pathname === '/api/config/import') {
    const body = await readJsonBody(req, IMPORT_MAX_BYTES);
    let counts;
    try {
      counts = store.replaceConfig(body);
    } catch (err) {
      sendError(res, 400, `could not import config: ${err.message}`);
      return;
    }
    reschedule();                 // pick up the new endpoint set
    historyCache.clear();         // the imported endpoints have their own history
    invalidateSecurityCache();    // allowed_hosts may have changed
    store.recordEvent({ ts: Date.now(), kind: 'config_imported', message: 'Configuration imported from file — endpoints, groups, actions, and channels replaced' });
    sendJson(res, 200, { ok: true, counts });
    return;
  }

  // POST /api/config/reset — factory reset: wipe all config, history, and
  // settings (incl. the site password) back to a fresh-install state.
  if (method === 'POST' && url.pathname === '/api/config/reset') {
    store.resetAll();
    reschedule();                 // no endpoints left to poll
    historyCache.clear();         // and no history left to chart
    invalidateSecurityCache();    // password + allowed hosts are gone — auth is now off
    store.recordEvent({ ts: Date.now(), kind: 'config_reset', message: 'Application reset to a clean state from the config page — all config, history, and site password cleared' });
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /api/config/backup — download the full SQLite database file.
  if (method === 'GET' && url.pathname === '/api/config/backup') {
    store.checkpoint(); // fold the WAL in so the file is a complete snapshot
    const data = readFileSync(store.dbFile);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="flatline-backup.db"',
      'content-length': data.length
    });
    res.end(data);
    return;
  }

  // POST /api/config/restore — overwrite the DB with an uploaded backup and
  // reopen the connection in place (no restart). The body streams to disk (see
  // restoreTmpFile) rather than buffering in memory.
  if (method === 'POST' && url.pathname === '/api/config/restore') {
    const ctype = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'application/octet-stream') { sendError(res, 415, 'restore body must be application/octet-stream'); return; }
    try {
      await pipeline(req, createWriteStream(store.restoreTmpFile));
    } catch (err) {
      store.discardRestore();
      sendError(res, 400, `upload failed: ${err.message}`);
      return;
    }
    try {
      store.applyRestore();
    } catch (err) {
      sendError(res, 400, `invalid database backup: ${err.message}`);
      return;
    }
    reschedule();                 // poll the restored endpoint set
    historyCache.clear();         // the backup's history replaced what was charted
    invalidateSecurityCache();    // password/allowed hosts came from the backup
    markInterruptedRuns();        // runs in the backup belong to another process
    store.recordEvent({ ts: Date.now(), kind: 'db_restored', message: 'Database restored from an uploaded backup' });
    sendJson(res, 200, { ok: true, note: 'Database restored.' });
    return;
  }

  // ---- notification channels ----

  // POST /api/notifications/test — test a saved (id) or unsaved (draft) channel.
  if (url.pathname === '/api/notifications/test' && method === 'POST') {
    const body = await readJsonBody(req);
    const kind = body?.kind;
    if (!NOTIFY_CONFIG_FIELDS[kind]) { sendError(res, 400, 'unknown channel kind'); return; }
    const cfg = parseChannelConfig(kind, body.config, body.config?.events, body.config);
    if (typeof cfg === 'string') { sendError(res, 400, cfg); return; }

    const id = Number(body.id);
    const isSaved = Number.isInteger(id);
    let existing;
    if (isSaved) {
      existing = store.getNotificationChannel(id);
      if (!existing) { sendError(res, 404, 'channel not found'); return; }
    }
    const resolved = resolveSecrets(
      NOTIFY_SECRET_FIELDS[kind],
      existing && kind === existing.kind ? existing.secret_enc : null,
      body.secrets, isSaved
    );
    if (resolved.error) { sendError(res, 400, resolved.error); return; }

    const secretErr = checkChannelSecrets(kind, cfg, resolved.secrets);
    if (secretErr) { sendError(res, 400, secretErr); return; }

    sendJson(res, 200, await sendTest(kind, cfg, resolved.secrets, isSaved ? id : undefined));
    return;
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
      if (body.base_url !== undefined) {
        if (baseUrlSource() === 'env') {
          sendError(res, 400, 'the site URL is set via FLATLINE_BASE_URL — unset the environment variable instead');
          return;
        }
        // Blank is allowed and means "no link in notifications".
        const raw = cleanString(String(body.base_url), 2000);
        if (raw) {
          try {
            const u = new URL(raw);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') { sendError(res, 400, 'site URL must be http(s)'); return; }
          } catch {
            sendError(res, 400, 'site URL must be a valid URL');
            return;
          }
        }
        store.setSetting('base_url', raw.replace(/\/+$/, ''));
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

  // List/create/update/delete for the plain CRUD resources. Last, so every
  // sub-route above (/test, /:id/run, /:id/restore, …) keeps precedence — each
  // of those returns before reaching here.
  if (await handleResource(req, res, method, url.pathname)) return;

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

  const stages = [];
  if (body.stages !== undefined) {
    if (!Array.isArray(body.stages)) return 'stages must be an array';
    const known = new Set(store.listActionTargets().map((t) => t.id));
    for (const rawStage of body.stages) {
      if (typeof rawStage !== 'object' || rawStage === null) return 'each stage must be an object';

      const pass_rule = rawStage.pass_rule ?? 'any';
      if (pass_rule !== 'any' && pass_rule !== 'all') {
        return "stage pass_rule must be 'any' (fail if any step fails) or 'all' (fail only if all fail)";
      }

      const stageFailure = rawStage.on_failure ?? null;
      if (stageFailure !== null && stageFailure !== 'continue' && stageFailure !== 'stop') {
        return "stage on_failure must be 'continue', 'stop', or null to inherit the group setting";
      }

      // The gap held before this stage. 0 means "no gap"; the first stage's is
      // stored but never used, so a run reacts to an outage immediately.
      const wait_seconds = intInRange(rawStage.wait_seconds, 0, 3600, store.DEFAULT_STAGE_WAIT_SECONDS);

      if (!Array.isArray(rawStage.steps) || rawStage.steps.length === 0) {
        return 'each stage must have at least one step';
      }
      const steps = [];
      const seen = new Set(); // a target may appear at most once per stage, but may be reused in other stages
      for (const raw of rawStage.steps) {
        // A step with no target is a wait step: it holds the stage open instead
        // of acting on anything, so it has a duration rather than a limit.
        if (raw?.target_id == null) {
          if (raw?.wait_seconds == null) return 'a step must name a target or be a wait';
          steps.push({ wait_seconds: intInRange(raw.wait_seconds, 1, 3600, store.DEFAULT_STAGE_WAIT_SECONDS) });
          continue;
        }
        const n = Number(raw.target_id);
        if (!Number.isInteger(n) || !known.has(n)) return 'a stage contains an unknown target';
        if (seen.has(n)) return 'a stage lists the same target twice';
        seen.add(n);
        steps.push({ target_id: n, timeout_seconds: intInRange(raw?.timeout_seconds, 5, 3600, 60) });
      }
      stages.push({ pass_rule, on_failure: stageFailure, wait_seconds, steps });
    }
  }

  return {
    name, on_failure, stages,
    // Only a Flatline-triggered run has a group to watch; a manual one runs to
    // the end whatever this says.
    stop_on_restore: body.stop_on_restore ? 1 : 0,
    enabled: body.enabled === undefined || body.enabled ? 1 : 0
  };
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
  const merged = mergeSecrets(NOTIFY_SECRET_FIELDS[kind], baseEnc, body.secrets);
  if (merged.error) return merged.error;

  const secretErr = checkChannelSecrets(kind, cfg, decryptSecrets(merged.enc));
  if (secretErr) return secretErr;

  return {
    name,
    kind,
    config: JSON.stringify(cfg),
    secret_enc: merged.enc,
    enabled: body.enabled === undefined || body.enabled ? 1 : 0
  };
}

/** Validates an action-target payload; returns row values or a string error. */
function parseActionTargetInput(body, existing) {
  if (typeof body !== 'object' || body === null) return 'invalid body';

  const name = cleanString(body.name, 100);
  if (!name) return 'name is required (max 100 chars)';

  const kind = body.kind;
  if (!KIND_CONFIG_FIELDS[kind]) return "kind must be 'ssh', 'winrm', 'k8s', or 'http'";

  const cfg = parseInfraConfig(kind, body.config);
  if (typeof cfg === 'string') return cfg;

  // Changing kind invalidates old secrets (different field set). Changing either
  // restore step's method narrows the list the same way, so a credential that
  // step no longer connects with is dropped rather than left encrypted.
  const baseEnc = existing && kind === existing.kind ? existing.secret_enc : null;
  const merged = mergeSecrets(secretFieldsFor(kind, cfg), baseEnc, body.secrets);
  if (merged.error) return merged.error;

  return {
    name,
    kind,
    config: JSON.stringify(cfg),
    secret_enc: merged.enc,
    enabled: body.enabled === undefined || body.enabled ? 1 : 0
  };
}

/** Validates a wake-on-lan relay payload; returns row values or a string error. */
function parseRelayInput(body, existing) {
  if (typeof body !== 'object' || body === null) return 'invalid body';

  const name = cleanString(body.name, 100);
  if (!name) return 'name is required (max 100 chars)';

  const kind = body.kind;
  if (!RELAY_KINDS.includes(kind)) return "kind must be 'ssh' or 'winrm'";

  const cfg = parseRelayConfig(kind, body.config);
  if (typeof cfg === 'string') return cfg;

  const wake = parseWakeCommand(body.wake_command);
  if (wake.error) return wake.error;

  const net = parseRelayNetwork(body.network);
  if (net.error) return net.error;

  // Changing kind invalidates the old secrets (different field set).
  const baseEnc = existing && kind === existing.kind ? existing.secret_enc : null;
  const merged = mergeSecrets(RELAY_SECRET_FIELDS[kind], baseEnc, body.secrets);
  if (merged.error) return merged.error;

  return {
    name,
    kind,
    config: JSON.stringify(cfg),
    secret_enc: merged.enc,
    wake_command: wake.command,
    network: net.network,
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

// ---------- generic CRUD resources ----------

/**
 * The six resources that are pure CRUD. They differ only in their store
 * functions, their validator, whether a duplicate name is a 400 rather than a
 * crash, and a couple of side effects — so they are described here rather than
 * written out six times.
 *
 * Keyed by path prefix instead of a single path segment because the depth
 * varies: /api/endpoints/:id has one segment ahead of the id, while
 * /api/actions/targets/:id has two.
 *
 * `parse` returns row values or a string error, and takes the existing row on
 * update (null on create) — several validators need it to decide whether stored
 * credentials still apply. `guardUnique` is set for the two tables that declare
 * `name TEXT NOT NULL UNIQUE` (flatline_groups, action_groups).
 */
const RESOURCES = {
  endpoints: {
    notFound: 'endpoint not found',
    list: store.listEndpoints, get: store.getEndpoint,
    create: store.createEndpoint, update: store.updateEndpoint, remove: store.deleteEndpoint,
    parse: parseEndpointInput,
    // The poller's schedule is built from the endpoint set, so every write to it
    // has to rebuild the timers — a delete included.
    afterWrite: reschedule,
    // A delete takes the endpoint's checks with it (ON DELETE CASCADE), so the
    // charts memoised from them have to go too.
    afterDelete: () => { reschedule(); historyCache.clear(); }
  },
  groups: {
    notFound: 'group not found',
    list: store.listFlatlineGroups, get: store.getFlatlineGroup,
    create: store.createFlatlineGroup, update: store.updateFlatlineGroup, remove: store.deleteFlatlineGroup,
    parse: parseFlatlineGroupInput,
    guardUnique: true
  },
  'actions/targets': {
    notFound: 'target not found',
    list: store.listActionTargets, get: store.getActionTarget,
    create: store.createActionTarget, update: store.updateActionTarget, remove: store.deleteActionTarget,
    parse: parseActionTargetInput,
    public: publicTarget,
    // A new or edited target gets its connectivity dot straight away rather than
    // waiting out the background poll.
    afterWrite: (row) => void checkTargetNow(row.id),
    afterDelete: clearTargetActivity
  },
  'actions/groups': {
    notFound: 'group not found',
    list: store.listActionGroups, get: store.getActionGroup,
    create: store.createActionGroup, update: store.updateActionGroup, remove: store.deleteActionGroup,
    parse: parseActionGroupInput,
    guardUnique: true
  },
  relays: {
    notFound: 'relay not found',
    list: store.listRelays, get: store.getRelay,
    create: store.createRelay, update: store.updateRelay, remove: store.deleteRelay,
    parse: parseRelayInput,
    public: publicRelay
  },
  notifications: {
    notFound: 'channel not found',
    list: store.listNotificationChannels, get: store.getNotificationChannel,
    create: store.createNotificationChannel, update: store.updateNotificationChannel,
    remove: store.deleteNotificationChannel,
    parse: parseNotificationInput,
    public: publicChannel,
    afterDelete: clearChannelResult
  }
};

/**
 * List/create/update/delete for whichever resource the path names. Returns true
 * when it answered the request and false when it did not, so the caller can fall
 * through to its 404 — which is also what an unsupported method on a real
 * resource does, matching the hand-written routes this replaced.
 */
async function handleResource(req, res, method, pathname) {
  const rest = pathname.slice('/api/'.length);
  const found = Object.entries(RESOURCES)
    .find(([prefix]) => rest === prefix || rest.startsWith(`${prefix}/`));
  if (!found) return false;

  const [prefix, r] = found;
  const tail = rest === prefix ? '' : rest.slice(prefix.length + 1);
  // Anything deeper is a sub-route (/:id/run, /:id/restore), matched earlier.
  if (tail.includes('/')) return false;
  const toPublic = r.public ?? ((row) => row);

  // A duplicate name is a user error on the two tables that forbid one; on the
  // rest it cannot happen, and a raw throw would be the honest answer.
  const write = (fn) => (r.guardUnique ? tryWrite(res, fn) : fn());

  if (tail === '') {
    if (method === 'GET') {
      sendJson(res, 200, r.list().map(toPublic));
      return true;
    }
    if (method === 'POST') {
      const input = r.parse(await readJsonBody(req), null);
      if (typeof input === 'string') { sendError(res, 400, input); return true; }
      const created = write(() => r.create(input));
      if (created) {
        r.afterWrite?.(created);
        sendJson(res, 201, toPublic(created));
      }
      return true;
    }
    return false;
  }

  const id = Number(tail);
  const existing = Number.isInteger(id) ? r.get(id) : undefined;
  if (!existing) { sendError(res, 404, r.notFound); return true; }

  if (method === 'PUT') {
    const input = r.parse(await readJsonBody(req), existing);
    if (typeof input === 'string') { sendError(res, 400, input); return true; }
    const updated = write(() => r.update(id, input));
    if (updated) {
      r.afterWrite?.(updated);
      sendJson(res, 200, toPublic(updated));
    }
    return true;
  }
  if (method === 'DELETE') {
    r.remove(id);
    r.afterDelete?.(id);
    sendJson(res, 200, { deleted: id });
    return true;
  }
  return false;
}

// ---------- static files ----------

const PAGE_ROUTES = {
  '/': '/index.html',
  '/flatline': '/flatline.html',
  '/actions': '/actions.html',
  '/config': '/config.html',
  '/login': '/login.html'
};

// Text assets are worth precompressing; PNG/ico are already compressed.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json']);

// Where the build token gets stitched in: every href/src pointing into the
// served tree, and every module specifier between the scripts. Both patterns
// only match paths into our own tree, so the nav links (/actions, /config) and
// the external GitHub link are left alone.
const HTML_ASSET_REF = /\b(href|src)="(\/(?:assets|scripts|shared)\/[^"?#]+)"/g;
const JS_MODULE_REF = /(\bfrom\s*['"])(\.\/[^'"]+\.js|\/shared\/[^'"]+\.js)(['"])/g;

function addBuildToken(text, ext, token) {
  if (ext === '.html') return text.replace(HTML_ASSET_REF, `$1="$2?v=${token}"`);
  if (ext === '.js') return text.replace(JS_MODULE_REF, `$1$2?v=${token}$3`);
  return text;
}

// The served tree is small and never changes at runtime, so we read it once
// into memory at startup with a content-hash ETag and precomputed brotli+gzip
// variants, and stamp every asset reference with a build token.
//
// The token is what makes a tab switch cheap. Without it every asset carries
// `no-cache`, which does not mean "don't cache" but "revalidate before each
// use" — so navigating between pages spent a network round trip per file just
// to be told nothing had changed. Over a VPN that was most of the wait. A
// token-carrying URL names content that cannot change under it, so it is
// served `immutable` and never asked about again. Pages themselves stay
// revalidated, which is what lets a new token reach the browser at all.
//
// Trade-off: editing a file needs a server restart to take effect.
const { cache: STATIC_CACHE, token: BUILD_TOKEN } = buildStaticCache();

function buildStaticCache() {
  const files = [];

  const walk = (base, dir, urlPrefix) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) { walk(base, abs, urlPrefix); continue; }
      files.push({
        key: urlPrefix + '/' + path.relative(base, abs).split(path.sep).join('/'),
        data: readFileSync(abs),
        ext: path.extname(abs).toLowerCase()
      });
    }
  };

  walk(PUBLIC_DIR, PUBLIC_DIR, '');
  // shared/ is imported by both sides: Node reads it off disk, the browser needs
  // it over HTTP, so it is served at /shared/* alongside the public tree.
  walk(SHARED_DIR, SHARED_DIR, '/shared');
  // Sorted so the token depends on the tree's contents and not on the order the
  // filesystem happened to hand them over.
  files.sort((a, b) => (a.key < b.key ? -1 : 1));

  // One token for the whole tree rather than a hash per file: the tree is a few
  // dozen KB, so re-fetching all of it after an upgrade is cheaper than the
  // machinery to invalidate each file on its own.
  const token = createHash('sha1')
    .update(Buffer.concat(files.map((f) => f.data)))
    .digest('base64url').slice(0, 12);

  const cache = new Map();
  for (const { key, data, ext } of files) {
    const body = ext === '.html' || ext === '.js'
      ? Buffer.from(addBuildToken(data.toString('utf8'), ext, token))
      : data;
    const entry = {
      data: body,
      mime: MIME[ext] ?? 'application/octet-stream',
      etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
      variants: {}
    };
    if (COMPRESSIBLE.has(ext)) {
      entry.variants.gzip = zlib.gzipSync(body, { level: 9 });
      entry.variants.br = zlib.brotliCompressSync(body, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
      });
    }
    cache.set(key, entry);
  }
  return { cache, token };
}

// async only so the dispatcher's uniform `handler.catch(...)` still applies —
// the body itself is synchronous (everything is served from memory).
async function handleStatic(req, res, pathname, version) {
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
  const entry = STATIC_CACHE.get(rel);
  if (!entry) {
    sendError(res, 404, 'not found');
    return;
  }

  // A URL carrying the current build token names content that cannot change
  // under it, so the browser is told to keep it and stop asking. Everything
  // else — pages, and any stale-token URL left over from before an upgrade —
  // revalidates as it always did.
  const cacheControl = version === BUILD_TOKEN && entry.mime !== MIME['.html']
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  // Revalidate cheaply: unchanged assets come back as an empty 304.
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { etag: entry.etag, 'cache-control': cacheControl });
    res.end();
    return;
  }

  const enc = pickEncoding(req.headers['accept-encoding']);
  const body = (enc && entry.variants[enc]) ? entry.variants[enc] : entry.data;
  const headers = {
    'content-type': entry.mime,
    'cache-control': cacheControl,
    etag: entry.etag,
    vary: 'Accept-Encoding'
  };
  if (enc && entry.variants[enc]) headers['content-encoding'] = enc;
  res.writeHead(200, headers);
  res.end(body);
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
    : handleStatic(req, res, pathname, url.searchParams.get('v'));

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
  markInterruptedRuns();
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
