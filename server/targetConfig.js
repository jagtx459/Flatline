import * as store from './db.js';
import { intInRange, cleanString } from './inputs.js';

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

// The ssh/winrm restore sequence — see parseRestoreSequence().
const RESTORE_SEQUENCE_FIELDS = [
  'auto_restore', 'wol_mac', 'wake_mode', 'wake_relay_id', 'wol_broadcast',
  'restore_wait_seconds', 'restore_action',
  'restore_command', 'restore_url', 'restore_method', 'restore_body',
  'restore_auth_scheme', 'restore_header_name', 'restore_username'
];

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
  ssh:  ['host', 'port', 'username', 'auth_method', 'command', ...RESTORE_SEQUENCE_FIELDS],
  winrm: ['host', 'port', 'domain', 'username', 'command', ...RESTORE_SEQUENCE_FIELDS],
  k8s:  ['api_url', 'auth_method', 'action', 'command_method', 'command_path', 'command_body',
         'auto_restore', 'restore_wait_seconds', 'restore_uncordon', 'restore_restart_deployments',
         'restore_method', 'restore_path', 'restore_body'],
  http: ['url', 'method', 'auth_scheme', 'header_name', 'username', 'body',
         'insecure_tls', 'ca_cert', ...HTTP_LOGIN_FIELDS,
         'auto_restore', 'restore_wait_seconds', 'restore_url', 'restore_method', 'restore_body']
};

// Kinds whose restore is a sequence that opens by waiting — for a host to boot,
// or a cluster's API server to answer. Minutes, not seconds, so the manual
// Restore route answers 202 and leaves them running.
const SEQUENCE_RESTORE_KINDS = ['ssh', 'winrm', 'k8s'];

/** Whether a restore is going to take long enough to need answering 202. For
 *  http that depends on the target: only one that logs in has a safe probe to
 *  wait on, so only that one can sit there for minutes. */
export function isSequenceRestore(kind, config) {
  if (SEQUENCE_RESTORE_KINDS.includes(kind)) return true;
  return kind === 'http' && config.auth_scheme === 'login' && (config.restore_wait_seconds ?? 300) > 0;
}

const K8S_ACTIONS = ['drain', 'custom'];
const K8S_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
// Static schemes: one set of credentials, turned into headers and sent as-is.
// These are also the schemes offered to the ssh/winrm restore sequence's HTTP
// step, which has no room for a login round trip of its own.
const AUTH_SCHEMES = ['none', 'bearer', 'basic', 'header'];
// The http kind adds 'login' on top — "2-Step auth" in the UI: a first request
// trades credentials for a per-session token (a CSRF token, typically), which the
// real request then carries.
const HTTP_AUTH_SCHEMES = [...AUTH_SCHEMES, 'login'];
const LOGIN_AUTH_MODES = ['body', 'basic'];
const LOGIN_CONTENT_TYPES = ['json', 'form'];
const TOKEN_SOURCES = ['json', 'header', 'cookie'];
const RESTORE_ACTIONS = ['none', 'command', 'http'];
const WAKE_MODES = ['packet', 'relay'];
export const MAX_RESTORE_WAIT_SECONDS = 3600;
// RFC 7230 token — anything else could smuggle CR/LF into the request.
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

// Secret fields allowed per kind — stored only in the encrypted blob.
// ssh's sudo_password is optional: only needed when the command uses
// `sudo -S` and the host isn't set up with passwordless sudo (preferred).
// restore_token / restore_password belong to the restore sequence's optional
// HTTP step, which authenticates separately from the host login above it.
// http's login_password is the credential its 'login' auth scheme sends — an
// account password or an API key, depending on what the endpoint wants.
export const KIND_SECRET_FIELDS = {
  ssh:  ['password', 'private_key', 'passphrase', 'sudo_password', 'restore_token', 'restore_password'],
  winrm: ['password', 'restore_token', 'restore_password'],
  k8s:  ['token', 'kubeconfig'],
  http: ['token', 'password', 'login_password']
};

export const MAX_SECRET_LEN = 262_144; // room for kubeconfigs / private keys

// Config fields that hold a request body, a command or a PEM rather than a
// setting, and so get the larger length cap.
const BIG_CONFIG_FIELDS = ['body', 'command', 'command_body', 'restore_body', 'restore_command',
  'login_body', 'ca_cert'];

/**
 * The ssh/winrm restore sequence: an optional Wake-on-LAN packet, a wait for
 * the host to answer again, then an optional final step — a command on the
 * host, or an HTTP request Flatline sends itself (with its own auth, since the
 * service being resumed need not be the host that was shut down).
 *
 * Mutates `cfg`; returns an error string, or null when it's valid.
 */
function parseRestoreSequence(cfg, src) {
  cfg.auto_restore = src.auto_restore ? 1 : 0;
  cfg.restore_wait_seconds = intInRange(src.restore_wait_seconds, 0, MAX_RESTORE_WAIT_SECONDS, 300);

  if (cfg.wol_mac) {
    // Accept the usual separators, store one canonical form.
    const mac = cfg.wol_mac.replace(/[-.\s]/g, ':').toUpperCase();
    if (!MAC_RE.test(mac)) return 'Wake-on-LAN MAC must be six hex octets, e.g. AA:BB:CC:DD:EE:FF';
    cfg.wol_mac = mac;
  }
  if (cfg.wol_broadcast && !/^[A-Za-z0-9._-]{1,255}$/.test(cfg.wol_broadcast)) {
    return 'broadcast address must be a hostname or IPv4 address';
  }

  // How the packet gets sent: Flatline broadcasts it itself, or a relay already
  // on the target's network does it.
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

  if (cfg.restore_action && !RESTORE_ACTIONS.includes(cfg.restore_action)) {
    return `restore action must be one of ${RESTORE_ACTIONS.join('/')}`;
  }
  cfg.restore_action ??= 'none';

  if (cfg.restore_action === 'command' && !cfg.restore_command) {
    return 'a restore command is required when the restore step runs one';
  }
  if (cfg.restore_action === 'http') {
    if (!cfg.restore_url) return 'a restore URL is required when the restore step sends a request';
    try {
      const u = new URL(cfg.restore_url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'restore URL must be http(s)';
    } catch {
      return 'restore URL must be a valid URL';
    }
    if (cfg.restore_method && !HTTP_METHODS.includes(cfg.restore_method)) {
      return `restore method must be ${HTTP_METHODS.join('/')}`;
    }
    cfg.restore_method ??= 'POST';
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
      return parseRestoreSequence(cfg, src) ?? cfg;
    }
    case 'winrm': {
      if (!cfg.host) return 'host is required';
      if (!cfg.username) return 'username is required';
      cfg.port = intInRange(src.port, 1, 65_535, 5985);
      return parseRestoreSequence(cfg, src) ?? cfg;
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

      // The restore sequence: wait for the API server, then undo the action.
      cfg.auto_restore = src.auto_restore ? 1 : 0;
      cfg.restore_wait_seconds = intInRange(src.restore_wait_seconds, 0, MAX_RESTORE_WAIT_SECONDS, 300);
      cfg.restore_restart_deployments = src.restore_restart_deployments ? 1 : 0;

      // The restore request is offered whatever the trigger action was: a
      // drained cluster can need one of its own on the way back.
      if (cfg.restore_method && !K8S_METHODS.includes(cfg.restore_method)) return `restore method must be one of ${K8S_METHODS.join('/')}`;
      if (cfg.restore_path) cfg.restore_method ??= 'PATCH';

      if (cfg.action === 'custom') {
        if (!cfg.command_path) return 'command path is required for a custom action';
        if (cfg.command_method && !K8S_METHODS.includes(cfg.command_method)) return `command method must be one of ${K8S_METHODS.join('/')}`;
        cfg.command_method ??= 'PATCH';
        cfg.restore_uncordon = src.restore_uncordon ? 1 : 0;
      } else {
        delete cfg.restore_uncordon; // a drained cluster always uncordons — it is the mirror image
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

      // The restore request, and the wait that precedes it for a target that
      // logs in (see connectors.js restoreHttp).
      cfg.auto_restore = src.auto_restore ? 1 : 0;
      cfg.restore_wait_seconds = intInRange(src.restore_wait_seconds, 0, MAX_RESTORE_WAIT_SECONDS, 300);
      if (cfg.restore_url) {
        try {
          const u = new URL(cfg.restore_url);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'restore URL must be http(s)';
        } catch {
          return 'restore URL must be a valid URL';
        }
        if (cfg.restore_method && !HTTP_METHODS.includes(cfg.restore_method)) {
          return `restore method must be ${HTTP_METHODS.join('/')}`;
        }
        cfg.restore_method ??= 'POST';
      }
      break;
    }
  }
  return cfg;
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

/** Dotted-quad -> unsigned 32-bit, or null when it isn't four 0-255 octets. */
function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    // Reject '', '1e2', '01x' and anything else Number() would be lenient about.
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out * 256) + n;
  }
  return out;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
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

  const mask = bits === 0 ? 0 : (0xffff_ffff << (32 - bits)) >>> 0;
  return { network: `${intToIp((addr & mask) >>> 0)}/${bits}` };
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
