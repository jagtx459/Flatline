import * as store from './db.js';
import { intInRange, cleanString } from './inputs.js';
import { ipToInt, intToIp, prefixMask } from '../shared/net.js';
import { RESTORE_SECRETS_BY_KIND } from '../shared/restoreSecrets.js';

/**
 * Validation for everything the Actions page configures: an action target's
 * per-kind connection config and its restore sequence, and the Wake-on-LAN
 * relays a target can wake through.
 *
 * Split out of index.js so it can be driven from a test — index.js binds a port
 * at import time, so there was no way to reach these otherwise. The parsers
 * return either the clean config object or a string error, which the routes turn
 * into a 400; the two relay helpers return { value } or { error } instead,
 * because their success value is itself a string.
 */

/**
 * A restore is the same shape for every kind of target: an optional wake, a wait
 * for something to answer, then one action. What that action is — and what it
 * talks to — is the target owner's choice, not a consequence of how the target
 * was shut down. A cluster brought down over its API can be woken and revived
 * over SSH; a NAS shut down through its HTTP API can be woken by a magic packet
 * and finished off with a command. See parseRestore().
 */
export const RESTORE_KINDS = ['none', 'ssh', 'winrm', 'k8s', 'http'];

// Present whatever the restore method is: the toggle, the method itself, and
// the wake + wait that lead into it.
const RESTORE_COMMON_FIELDS = [
  'restore_enabled', 'auto_restore', 'restore_kind', 'restore_inherit',
  'wol_mac', 'wake_mode', 'wake_relay_id', 'wol_broadcast', 'restore_wait_seconds'
];

// What the restore connects to, per method. Dropped when the restore inherits
// the target's own connection, which it may do when the method matches the
// target's kind.
const RESTORE_CONNECTION_FIELDS = {
  none: [],
  ssh: ['restore_host', 'restore_port', 'restore_username', 'restore_auth_method'],
  winrm: ['restore_host', 'restore_port', 'restore_domain', 'restore_username'],
  k8s: ['restore_api_url', 'restore_k8s_auth'],
  http: ['restore_auth_scheme', 'restore_header_name', 'restore_username',
         'restore_insecure_tls', 'restore_ca_cert']
};

// What the restore does once it is connected. Kept whether or not the
// connection is inherited.
const RESTORE_ACTION_FIELDS = {
  none: [],
  ssh: ['restore_command'],
  winrm: ['restore_command'],
  k8s: ['restore_uncordon', 'restore_restart_deployments', 'restore_method', 'restore_path', 'restore_body'],
  http: ['restore_url', 'restore_method', 'restore_body']
};

const RESTORE_FIELDS = [...new Set([
  ...RESTORE_COMMON_FIELDS,
  ...Object.values(RESTORE_CONNECTION_FIELDS).flat(),
  ...Object.values(RESTORE_ACTION_FIELDS).flat()
])];

// The http kind's 'login' auth scheme — see parseHttpLogin(). The credentials
// themselves are not here: the username is `login_username` (plaintext, like
// every other username) and the password is a secret.
const HTTP_LOGIN_FIELDS = [
  'login_url', 'login_method', 'login_auth', 'login_content_type', 'login_body', 'login_username',
  'token_source', 'token_json_path', 'token_response_header', 'token_cookie', 'token_header',
  'session_cookie_name', 'session_cookie_json_path', 'send_cookies'
];

// Non-secret config fields allowed per target kind. Anything not listed here
// is dropped, so secret material can never sneak into the plaintext column.
export const KIND_CONFIG_FIELDS = {
  ssh:  ['host', 'port', 'username', 'auth_method', 'command', ...RESTORE_FIELDS],
  winrm: ['host', 'port', 'domain', 'username', 'command', ...RESTORE_FIELDS],
  k8s:  ['api_url', 'auth_method', 'action', 'command_method', 'command_path', 'command_body',
         ...RESTORE_FIELDS],
  http: ['url', 'method', 'auth_scheme', 'header_name', 'username', 'body',
         'insecure_tls', 'ca_cert', ...HTTP_LOGIN_FIELDS, ...RESTORE_FIELDS]
};

// Restore methods that open by polling something — a host booting, a cluster's
// control plane coming up. Minutes, not seconds, so the manual Restore route
// answers 202 and leaves them running.
const POLLING_RESTORE_KINDS = ['ssh', 'winrm', 'k8s'];

/**
 * Whether a restore is going to take long enough to need answering 202.
 *
 * A wake always qualifies: nothing answers a magic packet, so a wake is only
 * ever followed by a wait. Otherwise it depends on the method. The http one
 * never polls its own request — that need not be idempotent — so it waits only
 * when some other safe probe is at hand: the login of a target it inherits, or,
 * when it brings its own connection, the target's own test (see connectors.js
 * restoreHttp).
 */
export function isSequenceRestore(kind, config) {
  if (!config.restore_enabled) return false;
  if (config.wol_mac) return true;
  if (POLLING_RESTORE_KINDS.includes(config.restore_kind)) return true;
  if (config.restore_kind !== 'http' || (config.restore_wait_seconds ?? 300) <= 0) return false;
  // Coerced, because restore_inherit is stored as 0/1 and && would hand back
  // the 0 rather than a boolean.
  return config.restore_inherit
    ? config.auth_scheme === 'login'
    : kind !== 'http' || config.auth_scheme === 'login';
}

/** The secret fields a target may carry: its own connection's, plus the restore
 *  method's when that connects somewhere of its own. Narrowing this is what
 *  drops a stale restore credential once the method changes — mergeSecrets
 *  keeps only what is on the list. */
export function secretFieldsFor(kind, config) {
  const restoreKind = config.restore_enabled && !config.restore_inherit ? config.restore_kind : 'none';
  return [...KIND_SECRET_FIELDS[kind], ...(RESTORE_SECRETS_BY_KIND[restoreKind] ?? [])];
}

const K8S_ACTIONS = ['drain', 'custom'];
const K8S_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
// Static schemes: one set of credentials, turned into headers and sent as-is.
// These are also the schemes offered to an HTTP restore that brings its own
// connection, which has no room for a login round trip of its own.
const AUTH_SCHEMES = ['none', 'bearer', 'basic', 'header'];
// The http kind adds 'login' on top — "2-Step auth" in the UI: a first request
// trades credentials for a per-session token (a CSRF token, typically), which the
// real request then carries.
const HTTP_AUTH_SCHEMES = [...AUTH_SCHEMES, 'login'];
const LOGIN_AUTH_MODES = ['body', 'basic'];
const LOGIN_CONTENT_TYPES = ['json', 'form'];
const TOKEN_SOURCES = ['json', 'header', 'cookie'];
const WAKE_MODES = ['packet', 'relay'];
export const MAX_RESTORE_WAIT_SECONDS = 3600;
// RFC 7230 token — anything else could smuggle CR/LF into the request.
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

// Secret fields a target's own connection uses — stored only in the encrypted
// blob. The restore method's credentials are added on top by secretFieldsFor(),
// since which of them apply depends on the method chosen, not on the kind.
// ssh's sudo_password is optional: only needed when the command uses
// `sudo -S` and the host isn't set up with passwordless sudo (preferred).
// http's login_password is the credential its 'login' auth scheme sends — an
// account password or an API key, depending on what the endpoint wants.
export const KIND_SECRET_FIELDS = {
  ssh:  ['password', 'private_key', 'passphrase', 'sudo_password'],
  winrm: ['password'],
  k8s:  ['token', 'kubeconfig'],
  http: ['token', 'password', 'login_password']
};

export const MAX_SECRET_LEN = 262_144; // room for kubeconfigs / private keys

// Config fields that hold a request body, a command or a PEM rather than a
// setting, and so get the larger length cap.
const BIG_CONFIG_FIELDS = ['body', 'command', 'command_body', 'restore_body', 'restore_command',
  'login_body', 'ca_cert', 'restore_ca_cert'];

/** The wake that opens a restore: a magic packet Flatline broadcasts itself, or
 *  one a relay already on the target's network sends for it. Offered to every
 *  kind of target — what shut a machine down says nothing about whether it needs
 *  waking to come back. */
function parseWake(cfg, src) {
  if (cfg.wol_mac) {
    // Accept the usual separators, store one canonical form.
    const mac = cfg.wol_mac.replace(/[-.\s]/g, ':').toUpperCase();
    if (!MAC_RE.test(mac)) return 'Wake-on-LAN MAC must be six hex octets, e.g. AA:BB:CC:DD:EE:FF';
    cfg.wol_mac = mac;
  }
  if (cfg.wol_broadcast && !/^[A-Za-z0-9._-]{1,255}$/.test(cfg.wol_broadcast)) {
    return 'broadcast address must be a hostname or IPv4 address';
  }

  if (cfg.wake_mode && !WAKE_MODES.includes(cfg.wake_mode)) {
    return `wake mode must be one of ${WAKE_MODES.join('/')}`;
  }
  cfg.wake_mode ??= 'packet';
  if (cfg.wake_mode === 'relay') {
    // Choosing a relay is an explicit request to wake this host, so the MAC
    // stops being optional here — the relay would have nothing to send without
    // it. Both are errors rather than quiet drops: silently discarding the
    // relay left the form looking like the choice had never been made.
    if (!cfg.wol_mac) {
      return 'a Wake-on-LAN MAC address is required to wake this target through a relay';
    }
    const relayId = Number(src.wake_relay_id);
    if (!Number.isInteger(relayId) || !store.getRelay(relayId)) {
      return 'pick an existing relay to wake this target through';
    }
    cfg.wake_relay_id = relayId;
  } else {
    delete cfg.wake_relay_id;
  }
  return null;
}

/** The restore's own SSH or WinRM connection, when it does not inherit the
 *  target's. Same fields the target kind itself takes, under restore_ names. */
function parseRestoreShell(cfg, src, restoreKind) {
  if (!cfg.restore_host) return 'a host is required for the restore connection';
  if (!cfg.restore_username) return 'a username is required for the restore connection';
  cfg.restore_port = intInRange(src.restore_port, 1, 65_535, restoreKind === 'ssh' ? 22 : 5985);
  if (restoreKind === 'ssh') {
    if (cfg.restore_auth_method && !['password', 'key'].includes(cfg.restore_auth_method)) {
      return "restore auth_method must be 'password' or 'key'";
    }
    cfg.restore_auth_method ??= 'password';
  }
  return null;
}

/** The restore's own cluster connection. Mirrors the k8s kind: with a kubeconfig
 *  the server URL comes from the file, so the URL is only required for a plain
 *  bearer token. */
function parseRestoreK8sConnection(cfg, src) {
  if (cfg.restore_k8s_auth && !['token', 'kubeconfig'].includes(cfg.restore_k8s_auth)) {
    return "restore cluster auth must be 'token' or 'kubeconfig'";
  }
  cfg.restore_k8s_auth ??= 'token';
  if (cfg.restore_api_url) {
    try {
      const u = new URL(cfg.restore_api_url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'restore API server URL must be http(s)';
    } catch {
      return 'restore API server URL must be a valid URL';
    }
  } else if (cfg.restore_k8s_auth === 'token') {
    return 'a restore API server URL is required';
  }
  return null;
}

/** The restore's own HTTP auth, when it does not inherit the target's. Only the
 *  static schemes: a login round trip belongs to a target, which can hold the
 *  whole conversation it needs (see parseHttpLogin). */
function parseRestoreHttpAuth(cfg) {
  if (cfg.restore_auth_scheme && !AUTH_SCHEMES.includes(cfg.restore_auth_scheme)) {
    return `restore auth scheme must be one of ${AUTH_SCHEMES.join('/')}`;
  }
  cfg.restore_auth_scheme ??= 'none';
  if (cfg.restore_auth_scheme === 'header') {
    if (!cfg.restore_header_name) return 'header name is required for the restore request\'s custom-header scheme';
    if (!HEADER_NAME_RE.test(cfg.restore_header_name)) return 'restore header name contains invalid characters';
  }
  if (cfg.restore_auth_scheme === 'basic') {
    if (!cfg.restore_username) return 'username is required for the restore request\'s basic auth';
    if (/[\r\n:]/.test(cfg.restore_username)) return 'restore username contains invalid characters';
  }
  if (cfg.restore_ca_cert && !cfg.restore_ca_cert.includes('BEGIN CERTIFICATE')) {
    return 'the restore CA certificate must be PEM text (-----BEGIN CERTIFICATE-----)';
  }
  cfg.restore_insecure_tls = cfg.restore_insecure_tls ? 1 : 0;
  return null;
}

/**
 * A target's restore: off, or a wake + wait + one action, with the action's
 * method chosen independently of how the target itself is reached.
 *
 * `restore_inherit` reuses the target's own connection and credentials, and is
 * only on offer when the method matches the target's kind — an HTTP target has
 * no SSH login to lend an SSH restore, so that combination brings its own.
 *
 * Mutates `cfg`; returns an error string, or null when it's valid.
 */
function parseRestore(cfg, src, kind) {
  cfg.restore_enabled = src.restore_enabled ? 1 : 0;
  if (!cfg.restore_enabled) {
    // Leave nothing half-configured behind. It would be invisible in the form
    // yet still stored, and auto_restore would still arm it.
    for (const field of RESTORE_FIELDS) delete cfg[field];
    cfg.restore_enabled = 0;
    return null;
  }

  cfg.auto_restore = src.auto_restore ? 1 : 0;
  cfg.restore_wait_seconds = intInRange(src.restore_wait_seconds, 0, MAX_RESTORE_WAIT_SECONDS, 300);

  const wakeError = parseWake(cfg, src);
  if (wakeError) return wakeError;

  if (cfg.restore_kind && !RESTORE_KINDS.includes(cfg.restore_kind)) {
    return `restore method must be one of ${RESTORE_KINDS.join('/')}`;
  }
  cfg.restore_kind ??= 'none';
  // Inheriting means "the same machine or service, reached the same way", which
  // only exists when the method is the target's own kind.
  cfg.restore_inherit = cfg.restore_kind === kind && src.restore_inherit ? 1 : 0;

  if (cfg.restore_kind === 'none' && !cfg.wol_mac) {
    return 'a restore needs a wake or a method — otherwise there is nothing for it to do';
  }

  let error = null;
  switch (cfg.restore_kind) {
    case 'ssh':
    case 'winrm':
      if (!cfg.restore_inherit) error = parseRestoreShell(cfg, src, cfg.restore_kind);
      if (!error && !cfg.restore_command) error = 'a restore command is required for this restore method';
      break;
    case 'k8s':
      if (!cfg.restore_inherit) error = parseRestoreK8sConnection(cfg, src);
      if (!error) {
        cfg.restore_uncordon = src.restore_uncordon ? 1 : 0;
        cfg.restore_restart_deployments = src.restore_restart_deployments ? 1 : 0;
        if (cfg.restore_method && !K8S_METHODS.includes(cfg.restore_method)) {
          error = `restore method must be one of ${K8S_METHODS.join('/')}`;
        } else if (cfg.restore_path) {
          cfg.restore_method ??= 'PATCH';
        }
        if (!error && !cfg.restore_uncordon && !cfg.restore_restart_deployments && !cfg.restore_path) {
          error = 'pick at least one thing for the cluster restore to do';
        }
      }
      break;
    case 'http':
      if (!cfg.restore_inherit) error = parseRestoreHttpAuth(cfg);
      if (!error) {
        if (!cfg.restore_url) {
          error = 'a restore URL is required for this restore method';
        } else {
          try {
            const u = new URL(cfg.restore_url);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') error = 'restore URL must be http(s)';
          } catch {
            error = 'restore URL must be a valid URL';
          }
        }
        if (!error && cfg.restore_method && !HTTP_METHODS.includes(cfg.restore_method)) {
          error = `restore method must be ${HTTP_METHODS.join('/')}`;
        }
        cfg.restore_method ??= 'POST';
      }
      break;
  }
  if (error) return error;

  // Everything belonging to a method that is not the chosen one — and the
  // connection fields of one that inherits — would sit in the blob unreachable
  // from the form. The same reason the http kind clears a login it no longer
  // uses.
  const keep = new Set([
    ...RESTORE_COMMON_FIELDS,
    ...RESTORE_ACTION_FIELDS[cfg.restore_kind],
    ...(cfg.restore_inherit ? [] : RESTORE_CONNECTION_FIELDS[cfg.restore_kind])
  ]);
  for (const field of RESTORE_FIELDS) {
    if (!keep.has(field)) delete cfg[field];
  }
  return null;
}

/**
 * The http kind's 'login' auth scheme: where to log in, how to hand over the
 * credentials, where to read the token out of the response, and how to send it
 * on the real request.
 *
 * All of it is configured rather than guessed because every service does it
 * differently — the token comes back in a JSON body, a response header or a
 * cookie, and the session it belongs to travels either in the cookies the login
 * set or in one the client has to assemble from a field in the response body.
 *
 * Mutates `cfg`; returns an error string, or null when it's valid.
 */
function parseHttpLogin(cfg, src) {
  if (!cfg.login_url) return 'a login URL is required for the login auth scheme';
  try {
    const u = new URL(cfg.login_url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'login URL must be http(s)';
  } catch {
    return 'login URL must be a valid URL';
  }
  if (cfg.login_method && !HTTP_METHODS.includes(cfg.login_method)) {
    return `login method must be ${HTTP_METHODS.join('/')}`;
  }
  cfg.login_method ??= 'POST';

  if (cfg.login_auth && !LOGIN_AUTH_MODES.includes(cfg.login_auth)) {
    return `login credentials must be sent in the ${LOGIN_AUTH_MODES.join(' or ')}`;
  }
  cfg.login_auth ??= 'body';
  if (cfg.login_content_type && !LOGIN_CONTENT_TYPES.includes(cfg.login_content_type)) {
    return `login body must be ${LOGIN_CONTENT_TYPES.join(' or ')}`;
  }
  cfg.login_content_type ??= 'json';
  // The username reaches the wire either base64'd into a Basic header or
  // substituted into the body, so a newline in it could split the request.
  if (cfg.login_username && /[\r\n]/.test(cfg.login_username)) return 'login username contains invalid characters';
  if (cfg.login_auth === 'basic' && !cfg.login_username) return 'a login username is required for basic auth';
  if (cfg.login_auth === 'body' && !cfg.login_body) {
    return 'a login request body is required when the credentials are sent in it — use {username} and {password}';
  }

  if (cfg.token_source && !TOKEN_SOURCES.includes(cfg.token_source)) {
    return `token source must be one of ${TOKEN_SOURCES.join('/')}`;
  }
  cfg.token_source ??= 'json';
  if (cfg.token_source === 'json' && !cfg.token_json_path) {
    return 'a path to the token in the response body is required (e.g. data.csrf_token)';
  }
  if (cfg.token_source === 'header') {
    if (!cfg.token_response_header) return 'the name of the response header holding the token is required';
    if (!HEADER_NAME_RE.test(cfg.token_response_header)) return 'token response header name contains invalid characters';
  }
  if (cfg.token_source === 'cookie' && !cfg.token_cookie) {
    return 'the name of the cookie holding the token is required';
  }

  if (!cfg.token_header) return 'the header to send the token in is required (e.g. X-CSRF-Token)';
  if (!HEADER_NAME_RE.test(cfg.token_header)) return 'token header name contains invalid characters';

  // The session cookie is optional, but half of it is no use: a name with
  // nothing to fill it, or a value with nowhere to put it, is a mistake worth
  // naming rather than dropping in silence.
  if (cfg.session_cookie_name || cfg.session_cookie_json_path) {
    if (!cfg.session_cookie_name) return 'a session cookie name is required alongside its path in the response body';
    if (!cfg.session_cookie_json_path) return 'a path to the session cookie value in the response body is required alongside its name';
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(cfg.session_cookie_name)) {
      return 'session cookie name contains invalid characters';
    }
  }
  cfg.send_cookies = src.send_cookies ? 1 : 0;
  return null;
}

export function parseInfraConfig(kind, raw) {
  const src = typeof raw === 'object' && raw !== null ? raw : {};
  const cfg = {};
  for (const field of KIND_CONFIG_FIELDS[kind]) {
    const v = src[field];
    if (v === undefined || v === null || v === '') continue;
    cfg[field] = cleanString(String(v), BIG_CONFIG_FIELDS.includes(field) ? 10_000 : 2000);
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
      if (cfg.method && !HTTP_METHODS.includes(cfg.method)) return `method must be ${HTTP_METHODS.join('/')}`;
      cfg.method ??= 'POST';
      if (cfg.auth_scheme && !HTTP_AUTH_SCHEMES.includes(cfg.auth_scheme)) {
        return `auth_scheme must be one of ${HTTP_AUTH_SCHEMES.join('/')}`;
      }
      cfg.auth_scheme ??= 'none';
      if (cfg.auth_scheme === 'header') {
        if (!cfg.header_name) return 'header_name is required for the custom-header scheme';
        if (!HEADER_NAME_RE.test(cfg.header_name)) return 'header_name contains invalid characters';
      }
      if (cfg.auth_scheme === 'basic') {
        if (!cfg.username) return 'username is required for basic auth';
        if (/[\r\n:]/.test(cfg.username)) return 'username contains invalid characters';
      }
      if (cfg.auth_scheme === 'login') {
        const err = parseHttpLogin(cfg, src);
        if (err) return err;
      } else {
        // Leave no half-configured login behind when the scheme is switched back
        // — it would be invisible in the form but still stored.
        for (const field of HTTP_LOGIN_FIELDS) delete cfg[field];
      }

      // TLS verification is a per-target choice because it is a per-URL fact: a
      // service reached by hostname through a reverse proxy presents a trusted
      // certificate, while the same one on a bare IP serves a self-signed cert.
      cfg.insecure_tls = src.insecure_tls ? 1 : 0;
      if (cfg.ca_cert && !cfg.ca_cert.includes('BEGIN CERTIFICATE')) {
        return 'the CA certificate must be PEM text (-----BEGIN CERTIFICATE-----)';
      }
      break;
    }
  }

  // The restore is parsed last and identically for every kind: it is a choice
  // of its own, not a consequence of how the target is reached.
  return parseRestore(cfg, src, kind) ?? cfg;
}

// ---------- wake-on-lan relays ----------
// Connection fields mirror the ssh/winrm action-target kinds, because a relay is
// reached the same way — only the restore sequence's fields are absent, since a
// relay is never shut down, only asked to broadcast.

export const RELAY_KINDS = ['ssh', 'winrm'];
const RELAY_CONFIG_FIELDS = {
  ssh: ['host', 'port', 'username', 'auth_method'],
  winrm: ['host', 'port', 'domain', 'username']
};
export const RELAY_SECRET_FIELDS = {
  ssh: ['password', 'private_key', 'passphrase', 'sudo_password'],
  winrm: ['password']
};
const MAC_PLACEHOLDER = '{mac}';

/** Connection config for a relay. Returns a string error, or the clean object. */
export function parseRelayConfig(kind, raw) {
  const src = typeof raw === 'object' && raw !== null ? raw : {};
  const cfg = {};
  for (const field of RELAY_CONFIG_FIELDS[kind]) {
    const v = src[field];
    if (v === undefined || v === null || v === '') continue;
    cfg[field] = cleanString(String(v), 2000);
  }
  if (!cfg.host) return 'host is required';
  if (!cfg.username) return 'username is required';

  if (kind === 'ssh') {
    cfg.port = intInRange(src.port, 1, 65_535, 22);
    if (cfg.auth_method && !['password', 'key'].includes(cfg.auth_method)) {
      return "auth_method must be 'password' or 'key'";
    }
    cfg.auth_method ??= 'password';
  } else {
    cfg.port = intInRange(src.port, 1, 65_535, 5985);
  }
  return cfg;
}

/**
 * The broadcast domain a relay can reach, as CIDR. Stored normalised to the
 * network address, so 10.1.20.7/24 is kept as 10.1.20.0/24 — the host bits a
 * user happens to type carry no meaning here and would make the stored value
 * read like a specific machine. Returns { network } or { error }.
 */
export function parseRelayNetwork(raw) {
  const text = cleanString(raw, 43);
  if (!text) return { error: 'a network is required, as CIDR (e.g. 10.1.20.0/24)' };

  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text);
  if (!m) return { error: 'network must be CIDR, e.g. 10.1.20.0/24' };
  const addr = ipToInt(m[1]);
  const bits = Number(m[2]);
  if (addr === null) return { error: 'network address must be four octets of 0-255' };
  if (bits > 32) return { error: 'network prefix must be /0 to /32' };

  return { network: `${intToIp((addr & prefixMask(bits)) >>> 0)}/${bits}` };
}

/** The command the relay runs. Must carry {mac}, or it would wake nothing (or
 *  always the same machine) no matter which target asked. Returns
 *  { command } or { error } — unlike the config parsers, a bare string return
 *  could not be told apart from a valid command. */
export function parseWakeCommand(raw) {
  const command = cleanString(raw, 10_000);
  if (!command) return { error: 'a wake command is required' };
  if (!command.includes(MAC_PLACEHOLDER)) {
    return { error: `the wake command must include ${MAC_PLACEHOLDER}, which is replaced with the target's MAC address` };
  }
  return { command };
}
