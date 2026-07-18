import nodemailer from 'nodemailer';
import * as store from './db.js';
import { decryptSecrets } from './secrets.js';

/**
 * Notification channels: every recorded event (see db.js recordEvent) is
 * mapped to one of NOTIFY_EVENTS and delivered to each enabled channel that
 * subscribes to it. Webhook/Discord/ntfy senders are plain fetch(); email
 * goes through nodemailer (Node has no built-in SMTP client).
 *
 * Channel config (plaintext JSON column) holds the non-secret fields plus
 * events[] and the title/body templates; webhook URLs and tokens live in the
 * encrypted secret blob, write-only through the API like action-target
 * credentials. Delivery is fire-and-forget with a hard timeout; a failing
 * channel logs and never blocks monitoring or the shutdown watcher.
 */

const SEND_TIMEOUT_MS = 10_000;

// Last delivery attempt per channel — shown on the config page as a status
// pill so "is this channel actually working" doesn't require checking logs.
// channel id -> { ok, message, ts, trigger: 'test' | 'event' }
const lastResult = new Map();

export function getChannelResult(id) {
  return lastResult.get(id) ?? null;
}

export function clearChannelResult(id) {
  lastResult.delete(id);
}

function recordResult(id, result, trigger) {
  if (!Number.isInteger(id)) return;
  lastResult.set(id, { ok: result.ok, message: result.message, ts: Date.now(), trigger });
}

// Non-secret config fields allowed per channel kind (events/templates are
// handled separately). Mirrors KIND_CONFIG_FIELDS for action targets.
// email's 'secure' is handled specially (boolean, not a string field).
export const NOTIFY_CONFIG_FIELDS = {
  webhook: [],
  discord: [],
  ntfy:    ['server_url', 'topic', 'priority', 'auth_scheme', 'username'],
  email:   ['host', 'port', 'from', 'to', 'username']
};

// Secret fields per kind — stored only in the encrypted blob. Discord
// webhook URLs embed their token, so the whole URL is treated as a secret.
// ntfy's password is only meaningful with auth_scheme 'basic'.
export const NOTIFY_SECRET_FIELDS = {
  webhook: ['url', 'token'],
  discord: ['webhook_url'],
  ntfy:    ['token', 'password'],
  email:   ['password']
};

export const NOTIFY_EVENTS = [
  'endpoint_down', 'endpoint_up',
  'group_armed', 'group_disarmed', 'group_triggered',
  'action_ok', 'action_failed'
];

const EVENT_LABELS = {
  endpoint_down:  'Endpoint DOWN',
  endpoint_up:    'Endpoint UP',
  group_armed:    'Group armed',
  group_disarmed: 'Group recovered',
  group_triggered:'Group TRIGGERED',
  action_ok:      'Action step OK',
  action_failed:  'Action step FAILED'
};

// The "initial templating": defaults used when a channel doesn't override
// them, and pre-filled into the config-page form for new channels.
export const DEFAULT_TITLE_TEMPLATE = 'Flatline: {event}';
export const DEFAULT_BODY_TEMPLATE = '{message}\n{time}';

const MAX_TEMPLATE_LEN = 500;

/**
 * Validates a channel payload's non-secret part; returns a clean config
 * object (including events + templates) or a string error. The caller
 * validates name/kind and merges secrets separately.
 */
export function parseChannelConfig(kind, raw, rawEvents, rawTemplates) {
  const src = typeof raw === 'object' && raw !== null ? raw : {};
  const cfg = {};
  for (const field of NOTIFY_CONFIG_FIELDS[kind]) {
    const v = src[field];
    if (v === undefined || v === null || v === '') continue;
    const s = String(v).trim();
    if (s.length > 2000) return `${field} is too long`;
    cfg[field] = s;
  }

  switch (kind) {
    case 'ntfy': {
      cfg.server_url ??= 'https://ntfy.sh';
      const err = checkHttpUrl(cfg.server_url, 'server_url');
      if (err) return err;
      if (!cfg.topic) return 'topic is required';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfg.topic)) return 'topic may only contain letters, digits, - and _';
      if (cfg.priority !== undefined) {
        const p = Number(cfg.priority);
        if (!Number.isInteger(p) || p < 1 || p > 5) return 'priority must be 1-5';
        cfg.priority = p;
      }
      cfg.auth_scheme ??= 'none';
      if (!['none', 'token', 'basic'].includes(cfg.auth_scheme)) {
        return "auth_scheme must be 'none', 'token', or 'basic'";
      }
      if (cfg.auth_scheme === 'basic' && !cfg.username) return 'username is required for username/password auth';
      break;
    }
    case 'email': {
      if (!cfg.host) return 'SMTP host is required';
      if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(cfg.host)) return 'SMTP host must be a hostname or IP address';
      const port = cfg.port === undefined ? 587 : Number(cfg.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'port must be 1-65535';
      cfg.port = port;
      cfg.secure = src.secure === true || src.secure === 'true';
      const addrErr = checkEmailAddresses(cfg.from, 'from', 1) ?? checkEmailAddresses(cfg.to, 'to', 10);
      if (addrErr) return addrErr;
      break;
    }
  }

  const events = [];
  if (rawEvents !== undefined) {
    if (!Array.isArray(rawEvents)) return 'events must be an array';
    for (const ev of rawEvents) {
      if (!NOTIFY_EVENTS.includes(ev)) return `unknown event '${ev}'`;
      if (!events.includes(ev)) events.push(ev);
    }
  }
  cfg.events = events;

  const tpl = typeof rawTemplates === 'object' && rawTemplates !== null ? rawTemplates : {};
  for (const [key, fallback] of [['title_template', DEFAULT_TITLE_TEMPLATE], ['body_template', DEFAULT_BODY_TEMPLATE]]) {
    const v = tpl[key];
    if (v === undefined || v === null || v === '') { cfg[key] = fallback; continue; }
    if (typeof v !== 'string' || v.length > MAX_TEMPLATE_LEN) return `${key} must be a string of at most ${MAX_TEMPLATE_LEN} chars`;
    cfg[key] = v;
  }
  return cfg;
}

/** Validates one or a comma-separated list of plain addresses (no display names — keeps header injection impossible). */
function checkEmailAddresses(value, label, maxCount) {
  if (!value) return `${label} is required`;
  const addrs = value.split(',').map((a) => a.trim()).filter(Boolean);
  if (addrs.length === 0 || addrs.length > maxCount) {
    return `${label} must be ${maxCount === 1 ? 'one address' : `1-${maxCount} comma-separated addresses`}`;
  }
  for (const a of addrs) {
    if (a.length > 254 || !/^[^\s@,;<>()[\]\\"]+@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}$/.test(a)) {
      return `${label} contains an invalid address: ${a.slice(0, 80)}`;
    }
  }
  return null;
}

function checkHttpUrl(value, label) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${label} must be http(s)`;
  } catch {
    return `${label} must be a valid URL`;
  }
  return null;
}

/** Validates secret values for a kind after merging (URLs must parse, etc). cfg supplies scheme-dependent requirements. */
export function checkChannelSecrets(kind, cfg, secrets) {
  if (kind === 'webhook') {
    if (!secrets.url) return 'url is required';
    return checkHttpUrl(secrets.url, 'url');
  }
  if (kind === 'discord') {
    if (!secrets.webhook_url) return 'webhook_url is required';
    return checkHttpUrl(secrets.webhook_url, 'webhook_url');
  }
  if (kind === 'ntfy') {
    if (cfg?.auth_scheme === 'token' && !secrets.token) return 'access token is required for token auth';
    if (cfg?.auth_scheme === 'basic' && !secrets.password) return 'password is required for username/password auth';
  }
  return null;
}

// ---------------- templating ----------------

/** {placeholder} substitution; unknown placeholders are left as-is. */
function renderTemplate(tpl, ctx) {
  return tpl.replace(/\{(\w+)\}/g, (m, name) => (ctx[name] !== undefined ? String(ctx[name]) : m));
}

/** Builds the placeholder context for one mapped event. */
function templateContext(eventKind, ev, endpointName) {
  return {
    event: EVENT_LABELS[eventKind] ?? eventKind,
    kind: eventKind,
    endpoint: endpointName ?? '',
    message: ev.message ?? EVENT_LABELS[eventKind] ?? eventKind,
    time: new Date(ev.ts ?? Date.now()).toLocaleString(),
    state: ev.toState ?? ''
  };
}

// ---------------- event mapping + dispatch ----------------

/** Maps a raw recorded event (db.js recordEvent shape) to a NOTIFY_EVENTS kind, or null to skip. */
function mapEvent(ev) {
  switch (ev.kind) {
    case 'state':
      if (ev.toState === 'down') return 'endpoint_down';
      if (ev.toState === 'up' && ev.fromState === 'down') return 'endpoint_up';
      return null;
    case 'shutdown_armed': return 'group_armed';
    case 'shutdown_disarmed': return 'group_disarmed';
    case 'shutdown_triggered': return 'group_triggered';
    case 'action_step_ok': return 'action_ok';
    case 'action_step_failed': return 'action_failed';
    default: return null;
  }
}

export function startNotifier() {
  store.onEvent((ev) => void handleEvent(ev));
}

async function handleEvent(ev) {
  try {
    const eventKind = mapEvent(ev);
    if (!eventKind) return;

    const channels = store.listNotificationChannels().filter((c) => c.enabled);
    if (channels.length === 0) return;

    let endpointName = null;
    if (ev.endpointId != null) endpointName = store.getEndpoint(ev.endpointId)?.name ?? null;
    // For endpoint state events the stored message is just the raw error, so
    // build a readable default; templates can still use {endpoint}/{state}.
    const enriched = ev.kind === 'state'
      ? { ...ev, message: `${endpointName ?? 'Endpoint'} is ${ev.toState.toUpperCase()}${ev.message ? ` (${ev.message})` : ''}` }
      : ev;

    const ctx = templateContext(eventKind, enriched, endpointName);
    await Promise.all(channels.map(async (ch) => {
      let cfg;
      try { cfg = JSON.parse(ch.config); } catch { cfg = {}; }
      if (!Array.isArray(cfg.events) || !cfg.events.includes(eventKind)) return;
      const result = await sendToChannel(ch.kind, cfg, decryptSecrets(ch.secret_enc), ctx);
      recordResult(ch.id, result, 'event');
      if (!result.ok) console.error(`[notify] "${ch.name}" (${ch.kind}) failed: ${result.message}`);
    }));
  } catch (err) {
    console.error('[notify] dispatch failed:', err);
  }
}

/**
 * Sends a sample event through a channel — the config page's Test button.
 * channelId is set when testing an already-saved channel (not a draft), so
 * the attempt shows up as that channel's last result on the config page.
 */
export async function sendTest(kind, cfg, secrets, channelId) {
  const ctx = templateContext('endpoint_down', {
    ts: Date.now(),
    message: 'This is a test notification from Flatline'
  }, 'test-endpoint');
  const result = await sendToChannel(kind, cfg, secrets, ctx);
  recordResult(channelId, result, 'test');
  return result;
}

// ---------------- senders ----------------

async function sendToChannel(kind, cfg, secrets, ctx) {
  const title = renderTemplate(cfg.title_template || DEFAULT_TITLE_TEMPLATE, ctx);
  const body = renderTemplate(cfg.body_template || DEFAULT_BODY_TEMPLATE, ctx);
  try {
    switch (kind) {
      case 'webhook': return await sendWebhook(cfg, secrets, ctx, title, body);
      case 'discord': return await postJson(secrets.webhook_url, { username: 'Flatline', content: `**${title}**\n${body}`.slice(0, 1900) });
      case 'ntfy': return await sendNtfy(cfg, secrets, title, body);
      case 'email': return await sendEmail(cfg, secrets, title, body);
      default: return { ok: false, message: `unknown channel kind '${kind}'` };
    }
  } catch (err) {
    return { ok: false, message: err.name === 'TimeoutError' ? 'timeout' : (err.cause?.message ?? err.message) };
  }
}

async function postJson(url, payload, headers = {}) {
  if (!url) return { ok: false, message: 'no URL configured' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'flatline', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
  });
  const text = await res.text().catch(() => '');
  return res.ok
    ? { ok: true, message: `delivered (${res.status})` }
    : { ok: false, message: `${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
}

async function sendWebhook(cfg, secrets, ctx, title, body) {
  const headers = {};
  if (secrets.token) headers.authorization = `Bearer ${secrets.token}`;
  return postJson(secrets.url, {
    event: ctx.kind,
    title,
    message: body,
    endpoint: ctx.endpoint || undefined,
    timestamp: Date.now()
  }, headers);
}

async function sendEmail(cfg, secrets, title, body) {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port ?? 587,
    secure: !!cfg.secure, // implicit TLS (465); otherwise STARTTLS when offered
    auth: cfg.username ? { user: cfg.username, pass: secrets.password ?? '' } : undefined,
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS
  });
  try {
    // Subject is a header: keep it to one line regardless of the template.
    const info = await transport.sendMail({
      from: cfg.from,
      to: cfg.to,
      subject: title.replace(/[\r\n]+/g, ' ').slice(0, 200),
      text: body
    });
    return { ok: true, message: `delivered (${info.response?.slice(0, 100) ?? 'accepted'})` };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    transport.close();
  }
}

async function sendNtfy(cfg, secrets, title, body) {
  const base = (cfg.server_url ?? 'https://ntfy.sh').replace(/\/+$/, '');
  // Title travels as an HTTP header: strip CR/LF (header injection) and
  // non-Latin-1 (fetch would reject the header value outright).
  const headers = {
    'user-agent': 'flatline',
    // eslint-disable-next-line no-control-regex
    title: title.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200)
  };
  if (cfg.priority) headers.priority = String(cfg.priority);
  if (cfg.auth_scheme === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${cfg.username ?? ''}:${secrets.password ?? ''}`).toString('base64')}`;
  } else if (cfg.auth_scheme === 'token' && secrets.token) {
    headers.authorization = `Bearer ${secrets.token}`;
  }
  const res = await fetch(`${base}/${encodeURIComponent(cfg.topic)}`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
  });
  const text = await res.text().catch(() => '');
  return res.ok
    ? { ok: true, message: `delivered (${res.status})` }
    : { ok: false, message: `${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
}
