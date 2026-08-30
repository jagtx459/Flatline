import * as store from './db.js';
import { intInRange, cleanString } from './inputs.js';
import { ipToInt, intToIp, prefixMask } from '../shared/net.js';
import { RESTORE_SECRETS_BY_KIND, POST_RESTORE_SECRETS_BY_KIND } from '../shared/restoreSecrets.js';

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
 * A restore is the same three steps for every kind of target:
 *
 *   1. the restore itself — wake the machine, bring the cluster back, or call an
 *      endpoint that resumes the service,
 *   2. the wait for something to answer,
 *   3. an optional post-restore action, run once step 1 is done.
 *
 * Neither step is a consequence of how the target was shut down. A cluster
 * brought down over its API can be woken by a magic packet and revived over SSH;
 * a NAS shut down through its HTTP API can be woken and finished off with a
 * command. See parseRestore().
 *
 * Step 1 offers only the methods that can bring something back from nothing —
 * you cannot SSH into a machine that is off — so a shell command is a step-3
 * action, never the thing that starts the restore.
 */
const RESTORE_KINDS = ['wol', 'k8s', 'http'];
const POST_RESTORE_KINDS = ['none', 'ssh', 'winrm', 'k8s', 'http'];

// Every per-step field is its own bare name under one of two prefixes —
// `restore_` for step 1, `post_restore_` for step 3 — so both steps are parsed
// by the same code.

// Present whatever either step is: the toggle, the two methods, and the wait
// between them.
const RESTORE_COMMON_FIELDS = [
  'restore_enabled', 'auto_restore', 'restore_wait_seconds',
  'restore_kind', 'restore_inherit', 'post_restore_kind', 'post_restore_inherit'
];

// The wake, which is what step 1 configures when its method is 'wol'.
const WAKE_FIELDS = ['wol_mac', 'wake_mode', 'wake_relay_id', 'wol_broadcast'];

// What a step connects to, per method. Dropped when the step inherits the
// target's own connection, which it may do when its method matches the target's
// kind.
const STEP_CONNECTION_FIELDS = {
  wol: [],
  none: [],
  ssh: ['host', 'port', 'username', 'auth_method'],
  winrm: ['host', 'port', 'domain', 'username'],
  k8s: ['api_url', 'k8s_auth'],
  http: ['auth_scheme', 'header_name', 'username', 'insecure_tls', 'ca_cert']
};

// What a step does once it is connected. Kept whether or not the connection is
// inherited.
const STEP_ACTION_FIELDS = {
  wol: [],
  none: [],
  ssh: ['command'],
  winrm: ['command'],
  k8s: ['uncordon', 'restart_deployments', 'method', 'path', 'body'],
  http: ['url', 'method', 'body']
};

/** A step's fields under its own prefix — every one it could have, or only the
 *  ones it keeps once the method and the inherit choice are known. */
function stepFields(prefix, kinds, inherits = false) {
  return [...new Set(kinds.flatMap((k) => [
    ...STEP_ACTION_FIELDS[k],
    ...(inherits ? [] : STEP_CONNECTION_FIELDS[k])
  ]).map((field) => prefix + field))];
}

const RESTORE_FIELDS = [...new Set([
  ...RESTORE_COMMON_FIELDS,
  ...WAKE_FIELDS,
  ...stepFields('restore_', RESTORE_KINDS),
  ...stepFields('post_restore_', POST_RESTORE_KINDS)
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

// Post-restore actions that open by polling something — a host booting, a
// cluster's control plane coming up. Minutes, not seconds, so the manual Restore
// route answers 202 and leaves them running.
const POLLING_POST_KINDS = ['ssh', 'winrm', 'k8s'];

/**
 * Whether a restore is going to take long enough to need answering 202.
 *
 * A wake always qualifies: nothing answers a magic packet, so a wake is only
 * ever followed by a wait. So does anything that polls, in either step. The http
 * method never polls its own request — that need not be idempotent — so it waits
 * only when some other safe probe is at hand: the login of a target it inherits,
 * or, when it brings its own connection, the target's own test (see
 * connectors.js restoreHttp).
 */
export function isSequenceRestore(kind, config) {
  if (!config.restore_enabled) return false;
  if (config.wol_mac) return true;
  if (config.restore_kind === 'k8s') return true;
  if (POLLING_POST_KINDS.includes(config.post_restore_kind)) return true;
  if (config.restore_kind !== 'http' || (config.restore_wait_seconds ?? 300) <= 0) return false;
  // Coerced, because restore_inherit is stored as 0/1 and && would hand back
  // the 0 rather than a boolean.
  return config.restore_inherit
    ? config.auth_scheme === 'login'
    : kind !== 'http' || config.auth_scheme === 'login';
}

/** The secret fields a target may carry: its own connection's, plus those of
 *  each restore step that connects somewhere of its own. Narrowing this is what
 *  drops a stale restore credential once a method changes — mergeSecrets keeps
 *  only what is on the list. */
export function secretFieldsFor(kind, config) {
  if (!config.restore_enabled) return [...KIND_SECRET_FIELDS[kind]];
  return [
    ...KIND_SECRET_FIELDS[kind],
    ...(config.restore_inherit ? [] : RESTORE_SECRETS_BY_KIND[config.restore_kind] ?? []),
    ...(config.post_restore_inherit ? [] : POST_RESTORE_SECRETS_BY_KIND[config.post_restore_kind] ?? [])
  ];
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
const KIND_SECRET_FIELDS = {
  ssh:  ['password', 'private_key', 'passphrase', 'sudo_password'],
  winrm: ['password'],
  k8s:  ['token', 'kubeconfig'],
  http: ['token', 'password', 'login_password']
};

export const MAX_SECRET_LEN = 262_144; // room for kubeconfigs / private keys

// Config fields that hold a request body, a command or a PEM rather than a
// setting, and so get the larger length cap.
const BIG_CONFIG_FIELDS = ['body', 'command', 'command_body', 'restore_body', 'restore_command',
  'login_body', 'ca_cert', 'restore_ca_cert',
  'post_restore_body', 'post_restore_command', 'post_restore_ca_cert'];

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

/** A step's own cluster connection. Mirrors the k8s kind: with a kubeconfig the
 *  server URL comes from the file, so the URL is only required for a plain
 *  bearer token. */
function parseStepK8sConnection(cfg, p, label) {
  if (cfg[`${p}k8s_auth`] && !['token', 'kubeconfig'].includes(cfg[`${p}k8s_auth`])) {
    return `${label} cluster auth must be 'token' or 'kubeconfig'`;
  }
  cfg[`${p}k8s_auth`] ??= 'token';
  if (cfg[`${p}api_url`]) {
    try {
      const u = new URL(cfg[`${p}api_url`]);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${label} API server URL must be http(s)`;
    } catch {
      return `${label} API server URL must be a valid URL`;
    }
  } else if (cfg[`${p}k8s_auth`] === 'token') {
    return `a ${label} API server URL is required`;
  }
  return null;
}

/** A step's own HTTP auth, when it does not inherit the target's. Only the
 *  static schemes: a login round trip belongs to a target, which can hold the
 *  whole conversation it needs (see parseHttpLogin). */
function parseStepHttpAuth(cfg, p, label) {
  if (cfg[`${p}auth_scheme`] && !AUTH_SCHEMES.includes(cfg[`${p}auth_scheme`])) {
    return `${label} auth scheme must be one of ${AUTH_SCHEMES.join('/')}`;
  }
  cfg[`${p}auth_scheme`] ??= 'none';
  if (cfg[`${p}auth_scheme`] === 'header') {
    if (!cfg[`${p}header_name`]) return `header name is required for the ${label} request's custom-header scheme`;
    if (!HEADER_NAME_RE.test(cfg[`${p}header_name`])) return `${label} header name contains invalid characters`;
  }
  if (cfg[`${p}auth_scheme`] === 'basic') {
    if (!cfg[`${p}username`]) return `username is required for the ${label} request's basic auth`;
    if (/[\r\n:]/.test(cfg[`${p}username`])) return `${label} username contains invalid characters`;
  }
  if (cfg[`${p}ca_cert`] && !cfg[`${p}ca_cert`].includes('BEGIN CERTIFICATE')) {
    return `the ${label} CA certificate must be PEM text (-----BEGIN CERTIFICATE-----)`;
  }
  cfg[`${p}insecure_tls`] = cfg[`${p}insecure_tls`] ? 1 : 0;
  return null;
}

/**
 * One step of a restore: where it connects, and what it does there. `p` is the
 * step's field prefix — `restore_` for step 1, `post_restore_` for step 3 — and
 * `label` names the step in the error messages, since the two are configured in
 * different places on the page.
 *
 * Inheriting reuses the target's own connection and credentials, and is only on
 * offer when the step's method matches the target's kind — an HTTP target has no
 * SSH login to lend an SSH step, so that combination brings its own.
 *
 * Mutates `cfg`; returns an error string, or null when it's valid.
 */
function parseRestoreStep(cfg, src, p, stepKind, kind, label) {
  const get = (name) => cfg[p + name];
  const set = (name, value) => { cfg[p + name] = value; };

  // "The same machine or service, reached the same way" only exists when the
  // step's method is the target's own kind.
  const inherits = stepKind === kind && src[`${p}inherit`] ? 1 : 0;
  set('inherit', inherits);

  switch (stepKind) {
    // A wake is configured by the wol_ fields, which belong to the restore as a
    // whole (see parseWake); 'none' is the absence of a step. Neither connects
    // anywhere or carries an action of its own.
    case 'wol':
    case 'none':
      return null;

    case 'ssh':
    case 'winrm':
      if (!inherits) {
        if (!get('host')) return `a host is required for the ${label} connection`;
        if (!get('username')) return `a username is required for the ${label} connection`;
        set('port', intInRange(src[`${p}port`], 1, 65_535, stepKind === 'ssh' ? 22 : 5985));
        if (stepKind === 'ssh') {
          if (get('auth_method') && !['password', 'key'].includes(get('auth_method'))) {
            return `${label} auth_method must be 'password' or 'key'`;
          }
          set('auth_method', get('auth_method') ?? 'password');
        }
      }
      if (!get('command')) return `a ${label} command is required for this method`;
      return null;

    case 'k8s': {
      if (!inherits) {
        const error = parseStepK8sConnection(cfg, p, label);
        if (error) return error;
      }
      set('uncordon', src[`${p}uncordon`] ? 1 : 0);
      set('restart_deployments', src[`${p}restart_deployments`] ? 1 : 0);
      if (get('method') && !K8S_METHODS.includes(get('method'))) {
        return `${label} request method must be one of ${K8S_METHODS.join('/')}`;
      }
      if (get('path')) set('method', get('method') ?? 'PATCH');
      if (!get('uncordon') && !get('restart_deployments') && !get('path')) {
        return `pick at least one thing for the ${label} cluster step to do`;
      }
      return null;
    }

    case 'http': {
      if (!inherits) {
        const error = parseStepHttpAuth(cfg, p, label);
        if (error) return error;
      }
      if (!get('url')) return `a ${label} URL is required for this method`;
      try {
        const u = new URL(get('url'));
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${label} URL must be http(s)`;
      } catch {
        return `${label} URL must be a valid URL`;
      }
      if (get('method') && !HTTP_METHODS.includes(get('method'))) {
        return `${label} request method must be ${HTTP_METHODS.join('/')}`;
      }
      set('method', get('method') ?? 'POST');
      return null;
    }
  }
  return null;
}

/**
 * A target's restore: off, or step 1 + the wait + an optional step 3, with each
 * step's method chosen independently of how the target itself is reached.
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

  if (cfg.restore_kind && !RESTORE_KINDS.includes(cfg.restore_kind)) {
    return `restore method must be one of ${RESTORE_KINDS.join('/')}`;
  }
  cfg.restore_kind ??= 'wol';
  if (cfg.post_restore_kind && !POST_RESTORE_KINDS.includes(cfg.post_restore_kind)) {
    return `post-restore action must be one of ${POST_RESTORE_KINDS.join('/')}`;
  }
  cfg.post_restore_kind ??= 'none';

  if (cfg.restore_kind === 'wol') {
    const wakeError = parseWake(cfg, src);
    if (wakeError) return wakeError;
    // A blank MAC is how "the machine is already on, just do the follow-up" is
    // said — but with no follow-up either, the restore does nothing at all.
    if (!cfg.wol_mac && cfg.post_restore_kind === 'none') {
      return 'a restore needs a MAC to wake or a post-restore action — otherwise there is nothing for it to do';
    }
  }

  const error = parseRestoreStep(cfg, src, 'restore_', cfg.restore_kind, kind, 'restore')
    ?? parseRestoreStep(cfg, src, 'post_restore_', cfg.post_restore_kind, kind, 'post-restore');
  if (error) return error;

  // Everything belonging to a method that is not the chosen one — and the
  // connection fields of a step that inherits — would sit in the blob
  // unreachable from the form. The same reason the http kind clears a login it
  // no longer uses.
  const keep = new Set([
    ...RESTORE_COMMON_FIELDS,
    ...(cfg.restore_kind === 'wol' ? WAKE_FIELDS : []),
    ...stepFields('restore_', [cfg.restore_kind], cfg.restore_inherit),
    ...stepFields('post_restore_', [cfg.post_restore_kind], cfg.post_restore_inherit)
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
