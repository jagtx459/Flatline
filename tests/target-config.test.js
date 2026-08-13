import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// What the Actions page will accept as a target's config, and what it hands
// back cleaned up. Everything here is server/targetConfig.js — the validation
// layer between a submitted form and the JSON stored in the config column.
//
// The parsers return either the clean object or a string error, so a test
// asserts on the type: a string means rejected. parseRestoreSequence and
// parseHttpLogin are reached through parseInfraConfig rather than directly,
// because that is the only way the routes call them.
//
// db.js opens a SQLite file at import time (targetConfig.js needs it to check a
// relay exists) — point it at a throwaway dir before the dynamic import.
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-targetcfg-'));
const store = await import('../server/db.js');
const {
  parseInfraConfig, parseRelayConfig, parseRelayNetwork, parseWakeCommand,
  isSequenceRestore, MAX_RESTORE_WAIT_SECONDS
} = await import('../server/targetConfig.js');

/** A relay for the wake-through-a-relay cases to point at. */
const relay = store.createRelay({
  name: 'garage-pi', kind: 'ssh',
  config: JSON.stringify({ host: '10.1.20.5', username: 'root', port: 22, auth_method: 'password' }),
  wake_command: 'wakeonlan {mac}', network: '10.1.20.0/24', secret_enc: null, enabled: 1
});

/** A valid ssh target, so each case only states the field it is about. */
const ssh = (over = {}) => parseInfraConfig('ssh', { host: '10.0.0.5', username: 'root', command: 'poweroff', ...over });
const http = (over = {}) => parseInfraConfig('http', { url: 'http://svc.local/hook', ...over });
const k8s = (over = {}) => parseInfraConfig('k8s', { api_url: 'https://10.0.0.1:6443', ...over });

// ---- the ssh/winrm restore sequence ----

describe('restore sequence: wake-on-lan', () => {
  test('a MAC is stored in one canonical form whichever separator was typed', () => {
    for (const typed of ['aa:bb:cc:dd:ee:ff', 'aa-bb-cc-dd-ee-ff', 'AA BB CC DD EE FF']) {
      assert.equal(ssh({ wol_mac: typed }).wol_mac, 'AA:BB:CC:DD:EE:FF', typed);
    }
  });

  test('anything that is not six hex octets is rejected', () => {
    // Rejected rather than dropped: a typo'd MAC would leave the target looking
    // wake-capable while every packet went to the wrong machine, or nowhere.
    for (const bad of ['aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:ff:00', 'zz:bb:cc:dd:ee:ff', 'aabb.ccdd.eeff', 'not-a-mac']) {
      assert.equal(typeof ssh({ wol_mac: bad }), 'string', bad);
    }
  });

  test('the broadcast address must look like a host or an IPv4 address', () => {
    assert.equal(ssh({ wol_broadcast: '10.0.0.255' }).wol_broadcast, '10.0.0.255');
    assert.equal(typeof ssh({ wol_broadcast: '10.0.0.255; rm -rf /' }), 'string');
  });

  test('waking through a relay needs both a MAC and a relay that exists', () => {
    const ok = ssh({ wake_mode: 'relay', wol_mac: 'AA:BB:CC:DD:EE:FF', wake_relay_id: relay.id });
    assert.equal(ok.wake_mode, 'relay');
    assert.equal(ok.wake_relay_id, relay.id);

    // Both are errors rather than quiet drops — silently discarding the relay
    // left the form looking like the choice had never been made.
    assert.match(ssh({ wake_mode: 'relay', wake_relay_id: relay.id }), /MAC address is required/);
    assert.match(ssh({ wake_mode: 'relay', wol_mac: 'AA:BB:CC:DD:EE:FF', wake_relay_id: relay.id + 999 }),
      /pick an existing relay/);
    assert.match(ssh({ wake_mode: 'relay', wol_mac: 'AA:BB:CC:DD:EE:FF' }), /pick an existing relay/);
  });

  test('switching back to broadcasting drops the relay it used to point at', () => {
    const cfg = ssh({ wake_mode: 'packet', wol_mac: 'AA:BB:CC:DD:EE:FF', wake_relay_id: relay.id });
    assert.equal('wake_relay_id' in cfg, false, 'a stale relay id would outlive the choice that set it');
  });

  test('an unknown wake mode is rejected, and the default is to broadcast', () => {
    assert.equal(ssh().wake_mode, 'packet');
    assert.equal(typeof ssh({ wake_mode: 'carrier-pigeon' }), 'string');
  });
});

describe('restore sequence: the final step', () => {
  test("restore_action 'none' is the default and asks for nothing else", () => {
    const cfg = ssh();
    assert.equal(cfg.restore_action, 'none');
    assert.equal(cfg.auto_restore, 0);
  });

  test("'command' requires a command", () => {
    assert.match(ssh({ restore_action: 'command' }), /restore command is required/);
    assert.equal(ssh({ restore_action: 'command', restore_command: 'systemctl start app' }).restore_command,
      'systemctl start app');
  });

  test("'http' requires a valid http(s) URL", () => {
    assert.match(ssh({ restore_action: 'http' }), /restore URL is required/);
    assert.match(ssh({ restore_action: 'http', restore_url: 'file:///etc/passwd' }), /must be http\(s\)/);
    assert.match(ssh({ restore_action: 'http', restore_url: 'not a url' }), /must be a valid URL/);
    assert.equal(ssh({ restore_action: 'http', restore_url: 'https://svc.local/start' }).restore_method, 'POST');
    assert.match(ssh({ restore_action: 'http', restore_url: 'https://svc.local/start', restore_method: 'TRACE' }),
      /restore method must be/);
  });

  test('an unknown restore action is rejected', () => {
    assert.match(ssh({ restore_action: 'reboot' }), /restore action must be one of/);
  });

  test("the restore request's auth scheme brings its own requirements", () => {
    const withUrl = (over) => ssh({ restore_action: 'http', restore_url: 'https://svc.local/start', ...over });

    assert.equal(withUrl().restore_auth_scheme, 'none');
    // 'login' is the http kind's scheme only — the restore step has no room for
    // a login round trip of its own.
    assert.match(withUrl({ restore_auth_scheme: 'login' }), /restore auth scheme must be one of/);

    assert.match(withUrl({ restore_auth_scheme: 'header' }), /header name is required/);
    assert.match(withUrl({ restore_auth_scheme: 'header', restore_header_name: 'X-Bad\r\nInjected: 1' }),
      /invalid characters/);
    assert.equal(withUrl({ restore_auth_scheme: 'header', restore_header_name: 'X-Api-Key' }).restore_header_name,
      'X-Api-Key');

    assert.match(withUrl({ restore_auth_scheme: 'basic' }), /username is required/);
    assert.match(withUrl({ restore_auth_scheme: 'basic', restore_username: 'ad\r\nmin' }), /invalid characters/);
    assert.equal(withUrl({ restore_auth_scheme: 'basic', restore_username: 'admin' }).restore_username, 'admin');
  });

  test('the wait is clamped to the allowed range and defaults to five minutes', () => {
    assert.equal(ssh().restore_wait_seconds, 300);
    assert.equal(ssh({ restore_wait_seconds: 0 }).restore_wait_seconds, 0);
    assert.equal(ssh({ restore_wait_seconds: -30 }).restore_wait_seconds, 0);
    assert.equal(ssh({ restore_wait_seconds: 99_999 }).restore_wait_seconds, MAX_RESTORE_WAIT_SECONDS);
    assert.equal(ssh({ restore_wait_seconds: 'soon' }).restore_wait_seconds, 300, 'nonsense falls back');
  });

  test('auto-restore is a flag, not free text', () => {
    assert.equal(ssh({ auto_restore: true }).auto_restore, 1);
    assert.equal(ssh({ auto_restore: 0 }).auto_restore, 0);
  });
});

// ---- the http kind's 'login' auth scheme ----

describe('http login auth scheme', () => {
  /** The smallest login config that validates; each case breaks one part. */
  const login = (over = {}) => http({
    auth_scheme: 'login',
    login_url: 'https://svc.local/login',
    login_auth: 'body',
    login_body: '{"u":"{username}","p":"{password}"}',
    token_source: 'json',
    token_json_path: 'data.csrf_token',
    token_header: 'X-CSRF-Token',
    ...over
  });

  test('the baseline config validates and fills in its defaults', () => {
    const cfg = login();
    assert.equal(typeof cfg, 'object', typeof cfg === 'string' ? cfg : '');
    assert.equal(cfg.login_method, 'POST');
    assert.equal(cfg.login_content_type, 'json');
    assert.equal(cfg.send_cookies, 0);
  });

  test('the login URL is required and must be http(s)', () => {
    assert.match(login({ login_url: '' }), /login URL is required/);
    assert.match(login({ login_url: 'ftp://svc.local/login' }), /must be http\(s\)/);
    assert.match(login({ login_url: '///' }), /must be a valid URL/);
    assert.match(login({ login_method: 'PATCH' }), /login method must be/);
  });

  test('basic login needs a username; body login needs a body template', () => {
    assert.match(login({ login_auth: 'basic', login_body: '' }), /login username is required/);
    assert.equal(login({ login_auth: 'basic', login_username: 'svc', login_body: '' }).login_username, 'svc');
    assert.match(login({ login_body: '' }), /login request body is required/);
    assert.match(login({ login_auth: 'sso' }), /login credentials must be sent in/);
    assert.match(login({ login_content_type: 'xml' }), /login body must be/);
  });

  test('a username that could split the request is rejected', () => {
    assert.match(login({ login_username: 'svc\r\nX-Admin: 1' }), /login username contains invalid characters/);
  });

  test('each token source requires its own locator', () => {
    assert.match(login({ token_json_path: '' }), /path to the token in the response body/);
    assert.match(login({ token_source: 'header' }), /response header holding the token/);
    assert.equal(login({ token_source: 'header', token_response_header: 'X-CSRF-Token' }).token_response_header,
      'X-CSRF-Token');
    assert.match(login({ token_source: 'cookie' }), /cookie holding the token/);
    assert.equal(login({ token_source: 'cookie', token_cookie: 'csrf' }).token_cookie, 'csrf');
    assert.match(login({ token_source: 'telepathy' }), /token source must be one of/);
  });

  test('a header name carrying CRLF is refused wherever it appears', () => {
    // Both ends of the token's journey: the header it is read from, and the one
    // it is sent in. Either could smuggle a second header onto the wire.
    assert.match(login({ token_source: 'header', token_response_header: 'X-Tok\r\nX-Admin: 1' }),
      /token response header name contains invalid characters/);
    assert.match(login({ token_header: 'X-Tok\r\nX-Admin: 1' }), /token header name contains invalid characters/);
    assert.match(login({ token_header: '' }), /header to send the token in is required/);
  });

  test('the session cookie needs both halves or neither', () => {
    assert.equal(login().session_cookie_name, undefined, 'optional');
    assert.match(login({ session_cookie_name: 'session' }), /path to the session cookie value/);
    assert.match(login({ session_cookie_json_path: 'data.session' }), /session cookie name is required/);
    const both = login({ session_cookie_name: 'session', session_cookie_json_path: 'data.session' });
    assert.equal(both.session_cookie_name, 'session');
    assert.match(login({ session_cookie_name: 'ses sion', session_cookie_json_path: 'data.session' }),
      /session cookie name contains invalid characters/);
  });

  test('switching the scheme away leaves no half-configured login behind', () => {
    // It would be invisible in the form but still stored, and would come back
    // the moment someone switched to 'login' again.
    const cfg = http({ auth_scheme: 'bearer', login_url: 'https://svc.local/login', token_header: 'X-CSRF-Token' });
    assert.equal('login_url' in cfg, false);
    assert.equal('token_header' in cfg, false);
  });
});

// ---- the http kind itself ----

describe('http target config', () => {
  test('the URL is required and must be http(s)', () => {
    assert.match(parseInfraConfig('http', {}), /url is required/);
    assert.match(parseInfraConfig('http', { url: 'ftp://svc.local' }), /url must be http\(s\)/);
    assert.match(parseInfraConfig('http', { url: 'nonsense' }), /url must be a valid URL/);
  });

  test('the static auth schemes each require their own field', () => {
    assert.equal(http().auth_scheme, 'none');
    assert.equal(http().method, 'POST');
    assert.match(http({ method: 'PATCH' }), /method must be/);
    assert.match(http({ auth_scheme: 'header' }), /header_name is required/);
    assert.match(http({ auth_scheme: 'header', header_name: 'X\r\nY: 1' }), /header_name contains invalid characters/);
    assert.match(http({ auth_scheme: 'basic' }), /username is required/);
    assert.match(http({ auth_scheme: 'basic', username: 'a:b' }), /username contains invalid characters/);
    assert.match(http({ auth_scheme: 'oauth2' }), /auth_scheme must be one of/);
  });

  test('a pinned CA has to be PEM text', () => {
    assert.match(http({ ca_cert: 'just some bytes' }), /must be PEM text/);
    assert.equal(http({ insecure_tls: true }).insecure_tls, 1);
  });

  test('the restore request is validated only once a URL is given', () => {
    assert.equal(http().restore_url, undefined, 'no restore request configured');
    assert.match(http({ restore_url: 'ftp://svc.local/start' }), /restore URL must be http\(s\)/);
    assert.match(http({ restore_url: 'not a url' }), /restore URL must be a valid URL/);
    assert.equal(http({ restore_url: 'https://svc.local/start' }).restore_method, 'POST');
    assert.match(http({ restore_url: 'https://svc.local/start', restore_method: 'PATCH' }), /restore method must be/);
  });
});

// ---- the k8s kind ----

describe('k8s target config', () => {
  test('a bearer token needs an api_url; a kubeconfig carries its own', () => {
    assert.match(parseInfraConfig('k8s', {}), /api_url is required/);
    const viaFile = parseInfraConfig('k8s', { auth_method: 'kubeconfig' });
    assert.equal(typeof viaFile, 'object', 'the server URL comes from the kubeconfig');
    assert.equal(viaFile.api_url, undefined);
    // Still allowed as an override, for a cluster reached by a different path
    // than the one baked into the file.
    assert.equal(parseInfraConfig('k8s', { auth_method: 'kubeconfig', api_url: 'https://10.0.0.1:6443' }).api_url,
      'https://10.0.0.1:6443');
    assert.match(k8s({ api_url: 'ftp://10.0.0.1' }), /api_url must be http\(s\)/);
    assert.match(k8s({ api_url: 'nope' }), /api_url must be a valid URL/);
    assert.match(k8s({ auth_method: 'certificate' }), /auth_method must be/);
  });

  test('the action defaults to draining, and a custom one needs a path', () => {
    assert.equal(k8s().action, 'drain');
    assert.match(k8s({ action: 'cordon' }), /action must be/);
    assert.match(k8s({ action: 'custom' }), /command path is required/);
    const custom = k8s({ action: 'custom', command_path: '/apis/apps/v1/namespaces/default/deployments/app' });
    assert.equal(custom.command_method, 'PATCH');
    assert.match(k8s({ action: 'custom', command_path: '/x', command_method: 'TRACE' }), /command method must be/);
  });

  test('only a custom action carries a restore_uncordon choice', () => {
    // A drained cluster always uncordons — it is the mirror image of the drain,
    // so storing the flag would let the form imply a choice that is not there.
    assert.equal('restore_uncordon' in k8s({ restore_uncordon: true }), false);
    assert.equal(k8s({ action: 'custom', command_path: '/x', restore_uncordon: true }).restore_uncordon, 1);
    assert.equal(k8s({ action: 'custom', command_path: '/x' }).restore_uncordon, 0);
  });

  test('the restore request is offered whatever the trigger action was', () => {
    assert.equal(k8s({ restore_path: '/apis/apps/v1/namespaces/default/deployments/app' }).restore_method, 'PATCH');
    assert.match(k8s({ restore_method: 'TRACE' }), /restore method must be one of/);
    assert.equal(k8s({ restore_restart_deployments: true }).restore_restart_deployments, 1);
  });
});

// ---- which restores answer 202 ----

describe('isSequenceRestore', () => {
  test('the kinds that open by waiting always do', () => {
    for (const kind of ['ssh', 'winrm', 'k8s']) {
      assert.equal(isSequenceRestore(kind, {}), true, kind);
    }
  });

  test('an http target does only when it logs in and has a wait to sit through', () => {
    // Only a target that logs in has a safe probe to wait on, so only that one
    // can sit there for minutes; everything else answers with its result.
    assert.equal(isSequenceRestore('http', { auth_scheme: 'login' }), true, 'the default 300s wait');
    assert.equal(isSequenceRestore('http', { auth_scheme: 'login', restore_wait_seconds: 0 }), false);
    assert.equal(isSequenceRestore('http', { auth_scheme: 'bearer', restore_wait_seconds: 300 }), false);
  });
});

// ---- fields that are not on the kind's list ----

test('a field the kind does not declare never reaches the stored config', () => {
  // The whitelist is what keeps secret material out of the plaintext column.
  const cfg = ssh({ password: 'hunter2', kubeconfig: 'apiVersion: v1', nonsense: 1 });
  assert.equal('password' in cfg, false);
  assert.equal('kubeconfig' in cfg, false);
  assert.equal('nonsense' in cfg, false);
});

test('an over-long value is dropped rather than truncated', () => {
  // cleanString returns '' past its cap, so a 3000-character host reads as a
  // missing one — better than storing a silently cut-off address.
  assert.match(parseInfraConfig('ssh', { host: 'h'.repeat(3000), username: 'root' }), /host is required/);
});

// ---- relays ----

describe('relay config', () => {
  test('a relay is reached like an ssh/winrm target and defaults its port', () => {
    const s = parseRelayConfig('ssh', { host: '10.1.20.5', username: 'root' });
    assert.deepEqual(s, { host: '10.1.20.5', username: 'root', port: 22, auth_method: 'password' });
    assert.equal(parseRelayConfig('winrm', { host: '10.1.20.6', username: 'admin' }).port, 5985);
    assert.match(parseRelayConfig('ssh', { username: 'root' }), /host is required/);
    assert.match(parseRelayConfig('ssh', { host: '10.1.20.5' }), /username is required/);
    assert.match(parseRelayConfig('ssh', { host: '10.1.20.5', username: 'root', auth_method: 'kerberos' }),
      /auth_method must be/);
  });

  test('the restore sequence has no place on a relay', () => {
    // A relay is never shut down, only asked to broadcast.
    const cfg = parseRelayConfig('ssh', { host: '10.1.20.5', username: 'root', wol_mac: 'AA:BB:CC:DD:EE:FF', auto_restore: 1 });
    assert.equal('wol_mac' in cfg, false);
    assert.equal('auto_restore' in cfg, false);
  });
});

describe('relay network', () => {
  test('a network is stored normalised to its network address', () => {
    // The host bits someone happens to type carry no meaning here, and would
    // make the stored value read like a specific machine.
    assert.equal(parseRelayNetwork('10.1.20.7/24').network, '10.1.20.0/24');
    assert.equal(parseRelayNetwork('10.1.20.0/24').network, '10.1.20.0/24');
    assert.equal(parseRelayNetwork('192.168.1.130/25').network, '192.168.1.128/25');
    assert.equal(parseRelayNetwork(' 10.0.0.0/8 ').network, '10.0.0.0/8');
    assert.equal(parseRelayNetwork('10.1.20.7/32').network, '10.1.20.7/32');
    assert.equal(parseRelayNetwork('10.1.20.7/0').network, '0.0.0.0/0');
  });

  test('anything that is not a CIDR block is refused', () => {
    assert.match(parseRelayNetwork('').error, /a network is required/);
    assert.match(parseRelayNetwork('10.1.20.0').error, /must be CIDR/);
    assert.match(parseRelayNetwork('10.1.20.0/24 or so').error, /must be CIDR/);
    assert.match(parseRelayNetwork('fe80::/64').error, /must be CIDR/);
    assert.match(parseRelayNetwork('10.1.300.0/24').error, /four octets of 0-255/);
    assert.match(parseRelayNetwork('10.1.20.0/33').error, /\/0 to \/32/);
  });
});

describe('relay wake command', () => {
  test('the command must carry {mac}', () => {
    // Without it the relay would wake nothing — or always the same machine —
    // no matter which target asked.
    assert.equal(parseWakeCommand('wakeonlan {mac}').command, 'wakeonlan {mac}');
    assert.equal(parseWakeCommand('  etherwake -i eth0 {mac}  ').command, 'etherwake -i eth0 {mac}');
    assert.match(parseWakeCommand('wakeonlan AA:BB:CC:DD:EE:FF').error, /must include \{mac\}/);
    assert.match(parseWakeCommand('').error, /wake command is required/);
    assert.match(parseWakeCommand(null).error, /wake command is required/);
  });
});
