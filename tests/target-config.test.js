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
// asserts on the type: a string means rejected. parseRestore and parseHttpLogin
// are reached through parseInfraConfig rather than directly, because that is the
// only way the routes call them.
//
// db.js opens a SQLite file at import time (targetConfig.js needs it to check a
// relay exists) — point it at a throwaway dir before the dynamic import.
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-targetcfg-'));
const store = await import('../server/db.js');
const {
  parseInfraConfig, parseRelayConfig, parseRelayNetwork, parseWakeCommand,
  isSequenceRestore, secretFieldsFor, MAX_RESTORE_WAIT_SECONDS
} = await import('../server/targetConfig.js');

// A restore is step 1 (a wake, a cluster, or an endpoint) -> the wait -> an
// optional step 3, whose fields live under post_restore_ names.

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

// ---- the restore, which is the same shape for every kind ----

/** An ssh target with its restore switched on, so each case states only the part
 *  of the restore it is about. A bare MAC is enough to be a valid restore. */
const restore = (over = {}) => ssh({ restore_enabled: 1, wol_mac: 'AA:BB:CC:DD:EE:FF', ...over });

describe('restore: the toggle', () => {
  test('a target has no restore until one is asked for', () => {
    const cfg = ssh();
    assert.equal(cfg.restore_enabled, 0);
    assert.equal('restore_kind' in cfg, false);
    assert.equal('auto_restore' in cfg, false);
  });

  test('switching it off leaves nothing behind', () => {
    // A half-configured restore would be invisible in the form yet still stored,
    // and auto_restore would still arm it.
    const cfg = ssh({
      restore_enabled: 0, auto_restore: 1, post_restore_kind: 'ssh',
      wol_mac: 'AA:BB:CC:DD:EE:FF', post_restore_command: 'systemctl start app'
    });
    assert.equal(cfg.restore_enabled, 0);
    for (const field of ['auto_restore', 'restore_kind', 'wol_mac', 'post_restore_kind', 'post_restore_command']) {
      assert.equal(field in cfg, false, field);
    }
  });

  test('a restore that would do nothing at all is refused', () => {
    // A wake with no MAC and no post-restore action: step 1 sends nothing and
    // there is no step 3 behind it.
    assert.match(ssh({ restore_enabled: 1 }), /needs a MAC to wake or a post-restore action/);
    // Either half on its own is enough.
    assert.equal(typeof ssh({ restore_enabled: 1, wol_mac: 'AA:BB:CC:DD:EE:FF' }), 'object');
    assert.equal(typeof ssh({
      restore_enabled: 1, post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'x'
    }), 'object', 'a machine already up, needing only the follow-up command');
  });

  test('the wait is clamped to the allowed range and defaults to five minutes', () => {
    assert.equal(restore().restore_wait_seconds, 300);
    assert.equal(restore({ restore_wait_seconds: 0 }).restore_wait_seconds, 0);
    assert.equal(restore({ restore_wait_seconds: -30 }).restore_wait_seconds, 0);
    assert.equal(restore({ restore_wait_seconds: 99_999 }).restore_wait_seconds, MAX_RESTORE_WAIT_SECONDS);
    assert.equal(restore({ restore_wait_seconds: 'soon' }).restore_wait_seconds, 300, 'nonsense falls back');
  });

  test('auto-restore is a flag, not free text', () => {
    assert.equal(restore({ auto_restore: true }).auto_restore, 1);
    assert.equal(restore({ auto_restore: 0 }).auto_restore, 0);
  });
});

describe('restore: wake-on-lan', () => {
  test('every kind of target can be woken, not just ssh and winrm', () => {
    // The whole point of the redesign: what shut a machine down says nothing
    // about whether it needs a magic packet to come back.
    for (const cfg of [
      k8s({ restore_enabled: 1, wol_mac: 'AA:BB:CC:DD:EE:FF' }),
      http({ restore_enabled: 1, wol_mac: 'AA:BB:CC:DD:EE:FF' }),
      parseInfraConfig('winrm', { host: '10.0.0.6', username: 'admin', restore_enabled: 1, wol_mac: 'AA:BB:CC:DD:EE:FF' })
    ]) {
      assert.equal(typeof cfg, 'object', typeof cfg === 'string' ? cfg : '');
      assert.equal(cfg.wol_mac, 'AA:BB:CC:DD:EE:FF');
    }
  });

  test('a MAC is stored in one canonical form whichever separator was typed', () => {
    for (const typed of ['aa:bb:cc:dd:ee:ff', 'aa-bb-cc-dd-ee-ff', 'AA BB CC DD EE FF']) {
      assert.equal(restore({ wol_mac: typed }).wol_mac, 'AA:BB:CC:DD:EE:FF', typed);
    }
  });

  test('anything that is not six hex octets is rejected', () => {
    // Rejected rather than dropped: a typo'd MAC would leave the target looking
    // wake-capable while every packet went to the wrong machine, or nowhere.
    for (const bad of ['aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:ff:00', 'zz:bb:cc:dd:ee:ff', 'aabb.ccdd.eeff', 'not-a-mac']) {
      assert.equal(typeof restore({ wol_mac: bad }), 'string', bad);
    }
  });

  test('the broadcast address must look like a host or an IPv4 address', () => {
    assert.equal(restore({ wol_broadcast: '10.0.0.255' }).wol_broadcast, '10.0.0.255');
    assert.equal(typeof restore({ wol_broadcast: '10.0.0.255; rm -rf /' }), 'string');
  });

  test('waking through a relay needs both a MAC and a relay that exists', () => {
    const ok = restore({ wake_mode: 'relay', wake_relay_id: relay.id });
    assert.equal(ok.wake_mode, 'relay');
    assert.equal(ok.wake_relay_id, relay.id);

    // Both are errors rather than quiet drops — silently discarding the relay
    // left the form looking like the choice had never been made.
    assert.match(ssh({ restore_enabled: 1, wake_mode: 'relay', wake_relay_id: relay.id }), /MAC address is required/);
    assert.match(restore({ wake_mode: 'relay', wake_relay_id: relay.id + 999 }), /pick an existing relay/);
    assert.match(restore({ wake_mode: 'relay' }), /pick an existing relay/);
  });

  test('switching back to broadcasting drops the relay it used to point at', () => {
    const cfg = restore({ wake_mode: 'packet', wake_relay_id: relay.id });
    assert.equal('wake_relay_id' in cfg, false, 'a stale relay id would outlive the choice that set it');
  });

  test('an unknown wake mode is rejected, and the default is to broadcast', () => {
    assert.equal(restore().wake_mode, 'packet');
    assert.equal(typeof restore({ wake_mode: 'carrier-pigeon' }), 'string');
  });
});

describe('restore: step 1, the restore itself', () => {
  test("waking is the default, and only what can start a restore is on offer", () => {
    const cfg = restore();
    assert.equal(cfg.restore_kind, 'wol');
    assert.equal(cfg.restore_inherit, 0);
    // A shell command cannot bring a machine back from being off, so it is a
    // step-3 action rather than a restore method.
    for (const restore_kind of ['ssh', 'winrm', 'telnet']) {
      assert.match(restore({ restore_kind }), /restore method must be one of/, restore_kind);
    }
  });

  test('the connection is only inheritable when the method matches the kind', () => {
    // "The same machine, reached the same way" only exists when the method is
    // the target's own kind.
    assert.equal(k8s({ restore_enabled: 1, restore_kind: 'k8s', restore_inherit: 1, restore_uncordon: 1 })
      .restore_inherit, 1);
    // An ssh target has no cluster credentials to lend a Kubernetes restore, so
    // the request to inherit is dropped and its own connection required.
    assert.match(restore({ restore_kind: 'k8s', restore_inherit: 1, restore_uncordon: 1 }),
      /restore API server URL is required/);
  });

  test('a cluster restore needs at least one thing to do', () => {
    const cluster = (over) => k8s({ restore_enabled: 1, restore_kind: 'k8s', restore_inherit: 1, ...over });
    assert.match(cluster({}), /at least one thing for the restore cluster step to do/);
    assert.equal(cluster({ restore_uncordon: 1 }).restore_uncordon, 1);
    assert.equal(cluster({ restore_restart_deployments: 1 }).restore_restart_deployments, 1);
    assert.equal(cluster({ restore_path: '/apis/apps/v1/namespaces/default/deployments/app' }).restore_method, 'PATCH');
    assert.match(cluster({ restore_uncordon: 1, restore_method: 'TRACE' }), /restore request method must be one of/);
  });

  test('an http restore needs a valid http(s) URL', () => {
    const undo = (over) => http({ restore_enabled: 1, restore_kind: 'http', restore_inherit: 1, ...over });
    assert.match(undo({}), /restore URL is required/);
    assert.match(undo({ restore_url: 'file:///etc/passwd' }), /must be http\(s\)/);
    assert.match(undo({ restore_url: 'not a url' }), /must be a valid URL/);
    assert.equal(undo({ restore_url: 'https://svc.local/start' }).restore_method, 'POST');
    assert.match(undo({ restore_url: 'https://svc.local/start', restore_method: 'PATCH' }),
      /restore request method must be/);
  });

  test("an http restore with its own connection carries its own auth, but never 'login'", () => {
    const own = (over) => ssh({
      restore_enabled: 1, restore_kind: 'http', restore_url: 'https://svc.local/start', ...over
    });
    assert.equal(own().restore_auth_scheme, 'none');
    // A login round trip belongs to a target, which can hold the whole
    // conversation it needs; the restore has no room for one.
    assert.match(own({ restore_auth_scheme: 'login' }), /restore auth scheme must be one of/);

    assert.match(own({ restore_auth_scheme: 'header' }), /header name is required/);
    assert.match(own({ restore_auth_scheme: 'header', restore_header_name: 'X-Bad\r\nInjected: 1' }),
      /invalid characters/);
    assert.equal(own({ restore_auth_scheme: 'header', restore_header_name: 'X-Api-Key' }).restore_header_name,
      'X-Api-Key');

    assert.match(own({ restore_auth_scheme: 'basic' }), /username is required/);
    assert.match(own({ restore_auth_scheme: 'basic', restore_username: 'ad\r\nmin' }), /invalid characters/);
    assert.equal(own({ restore_auth_scheme: 'basic', restore_username: 'admin' }).restore_username, 'admin');
    assert.match(own({ restore_ca_cert: 'just some bytes' }), /restore CA certificate must be PEM/);
  });

  test('switching method leaves no field of the old one behind', () => {
    // Same reason the http kind clears a login it no longer uses: it would sit
    // in the blob unreachable from the form.
    const cfg = restore({
      restore_url: 'https://svc.local/start', restore_path: '/apis/x', restore_api_url: 'https://10.0.0.1:6443'
    });
    assert.equal(cfg.wol_mac, 'AA:BB:CC:DD:EE:FF');
    for (const field of ['restore_url', 'restore_path', 'restore_api_url']) {
      assert.equal(field in cfg, false, field);
    }
  });

  test('the wake fields go with the wake', () => {
    // A cluster restore has nothing to broadcast to.
    const cfg = k8s({
      restore_enabled: 1, restore_kind: 'k8s', restore_inherit: 1, restore_uncordon: 1,
      wol_mac: 'AA:BB:CC:DD:EE:FF', wol_broadcast: '10.0.0.255'
    });
    assert.equal('wol_mac' in cfg, false);
    assert.equal('wol_broadcast' in cfg, false);
  });
});

describe('restore: step 3, the post-restore action', () => {
  test('there is none by default', () => {
    assert.equal(restore().post_restore_kind, 'none');
    assert.equal(restore().post_restore_inherit, 0);
    assert.match(restore({ post_restore_kind: 'telnet' }), /post-restore action must be one of/);
  });

  test('an inherited shell action needs only its command', () => {
    const cfg = restore({
      post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'systemctl start app'
    });
    assert.equal(cfg.post_restore_command, 'systemctl start app');
    assert.equal(cfg.post_restore_inherit, 1);
    assert.equal('post_restore_host' in cfg, false, 'nothing of its own to store');
    assert.match(restore({ post_restore_kind: 'ssh', post_restore_inherit: 1 }),
      /post-restore command is required/);
  });

  test('a shell action that brings its own connection needs a host and a user', () => {
    // An HTTP target finished off over SSH: the credentials cannot come from the
    // target, because it has none of that shape.
    const undo = (over) => http({ restore_enabled: 1, wol_mac: 'AA:BB:CC:DD:EE:FF', ...over });
    assert.match(undo({ post_restore_kind: 'ssh', post_restore_command: 'x' }), /host is required/);
    assert.match(undo({ post_restore_kind: 'ssh', post_restore_command: 'x', post_restore_host: '10.0.0.9' }),
      /username is required/);
    const cfg = undo({
      post_restore_kind: 'winrm', post_restore_command: 'Restart-Service app',
      post_restore_host: '10.0.0.9', post_restore_username: 'admin'
    });
    assert.equal(cfg.post_restore_port, 5985, 'the port defaults per method, not per target kind');
    assert.equal(cfg.post_restore_inherit, 0);
  });

  test('a cluster action is offered here too, with its own connection', () => {
    // The point of the split: a woken NAS, then a cluster brought back onto it.
    const cfg = ssh({
      restore_enabled: 1, wol_mac: 'AA:BB:CC:DD:EE:FF',
      post_restore_kind: 'k8s', post_restore_api_url: 'https://10.0.0.1:6443', post_restore_uncordon: 1
    });
    assert.equal(typeof cfg, 'object', typeof cfg === 'string' ? cfg : '');
    assert.equal(cfg.post_restore_k8s_auth, 'token');
    assert.match(ssh({ restore_enabled: 1, wol_mac: 'AA:BB:CC:DD:EE:FF', post_restore_kind: 'k8s' }),
      /post-restore API server URL is required/);
    assert.match(ssh({
      restore_enabled: 1, wol_mac: 'AA:BB:CC:DD:EE:FF',
      post_restore_kind: 'k8s', post_restore_api_url: 'https://10.0.0.1:6443'
    }), /at least one thing for the post-restore cluster step to do/);
  });

  test('both steps can talk to a different place at once', () => {
    // Step 1 resumes the service over its API; step 3 signs in to another host
    // and starts what depends on it. Neither connection displaces the other.
    const cfg = ssh({
      restore_enabled: 1,
      restore_kind: 'http', restore_url: 'https://svc.local/resume', restore_auth_scheme: 'bearer',
      post_restore_kind: 'ssh', post_restore_host: '10.0.0.9', post_restore_username: 'admin',
      post_restore_command: 'systemctl start app'
    });
    assert.equal(typeof cfg, 'object', typeof cfg === 'string' ? cfg : '');
    assert.equal(cfg.restore_url, 'https://svc.local/resume');
    assert.equal(cfg.post_restore_host, '10.0.0.9');
    assert.equal(cfg.restore_inherit, 0);
    assert.equal(cfg.post_restore_inherit, 0);
  });

  test('an inherited connection stores none of its own fields', () => {
    const cfg = restore({
      post_restore_kind: 'ssh', post_restore_inherit: 1, post_restore_command: 'x',
      post_restore_host: '10.9.9.9', post_restore_username: 'someone'
    });
    assert.equal('post_restore_host' in cfg, false);
    assert.equal('post_restore_username' in cfg, false);
  });
});

describe('restore credentials follow the methods', () => {
  test('an inherited step adds none of its own', () => {
    const fields = secretFieldsFor('ssh', {
      restore_enabled: 1, restore_kind: 'wol', post_restore_inherit: 1, post_restore_kind: 'ssh'
    });
    assert.deepEqual(fields, ['password', 'private_key', 'passphrase', 'sudo_password']);
  });

  test('each step with its own connection adds exactly that method\'s credentials', () => {
    // Narrowing the list is what drops a stale credential once a method
    // changes — mergeSecrets keeps only what is on it.
    assert.deepEqual(secretFieldsFor('http', {
      restore_enabled: 1, restore_inherit: 0, restore_kind: 'k8s', post_restore_kind: 'none'
    }), ['token', 'password', 'login_password', 'restore_token', 'restore_kubeconfig']);
    assert.deepEqual(secretFieldsFor('k8s', {
      restore_enabled: 1, restore_kind: 'wol', post_restore_inherit: 0, post_restore_kind: 'winrm'
    }), ['token', 'kubeconfig', 'post_restore_password']);
    // Both steps at once, each carrying its own set.
    assert.deepEqual(secretFieldsFor('ssh', {
      restore_enabled: 1, restore_inherit: 0, restore_kind: 'http',
      post_restore_inherit: 0, post_restore_kind: 'k8s'
    }), ['password', 'private_key', 'passphrase', 'sudo_password',
      'restore_token', 'restore_password', 'post_restore_token', 'post_restore_kubeconfig']);
    assert.deepEqual(secretFieldsFor('http', { restore_enabled: 0 }),
      ['token', 'password', 'login_password']);
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

  test('a restore URL is ignored until a restore is actually turned on', () => {
    assert.equal(http({ restore_url: 'https://svc.local/start' }).restore_url, undefined);
  });
});

// ---- the winrm kind ----

describe('winrm target config', () => {
  const winrm = (over = {}) => parseInfraConfig('winrm', { host: '10.0.0.6', username: 'admin', command: 'shutdown /s', ...over });

  test('the transport picks the port default, and a typed port still wins', () => {
    assert.equal(winrm().use_tls, 0);
    assert.equal(winrm().port, 5985);
    assert.equal(winrm({ use_tls: true }).use_tls, 1);
    assert.equal(winrm({ use_tls: true }).port, 5986);
    assert.equal(winrm({ use_tls: true, port: 5985 }).port, 5985, 'HTTPS on a non-default port is allowed');
  });

  test('the certificate settings only survive with HTTPS on', () => {
    // They would be invisible in the form but still stored, and would come back
    // the moment someone ticked HTTPS again.
    const cfg = winrm({ insecure_tls: true, ca_cert: '-----BEGIN CERTIFICATE-----\nabc' });
    assert.equal(cfg.insecure_tls, 0);
    assert.equal('ca_cert' in cfg, false);

    const tls = winrm({ use_tls: true, insecure_tls: true, ca_cert: '-----BEGIN CERTIFICATE-----\nabc' });
    assert.equal(tls.insecure_tls, 1);
    assert.match(tls.ca_cert, /BEGIN CERTIFICATE/);
  });

  test('a pinned CA has to be PEM text', () => {
    assert.match(winrm({ use_tls: true, ca_cert: 'just some bytes' }), /must be PEM text/);
  });

  test('a post-restore winrm action carries its own transport', () => {
    const undo = (over) => http({
      restore_enabled: 1, wol_mac: 'AA:BB:CC:DD:EE:FF',
      post_restore_kind: 'winrm', post_restore_command: 'Restart-Service app',
      post_restore_host: '10.0.0.9', post_restore_username: 'admin', ...over
    });
    assert.equal(undo({}).post_restore_port, 5985);
    assert.equal(undo({ post_restore_use_tls: true }).post_restore_port, 5986);
    assert.equal(undo({ post_restore_use_tls: true, post_restore_insecure_tls: true }).post_restore_insecure_tls, 1);
    assert.equal(undo({ post_restore_insecure_tls: true }).post_restore_insecure_tls, 0, 'no TLS, no certificate settings');
    assert.match(undo({ post_restore_use_tls: true, post_restore_ca_cert: 'nope' }), /must be PEM text/);
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

  test('uncordoning is no longer implied by the trigger action', () => {
    // It used to be inferred from a 'drain' target. It is an explicit choice
    // now, because the cluster being restored need not be the one shut down.
    assert.equal('restore_uncordon' in k8s({ restore_uncordon: true }), false, 'no restore configured');
    const cluster = k8s({ restore_enabled: 1, restore_kind: 'k8s', restore_inherit: 1, restore_uncordon: true });
    assert.equal(cluster.restore_uncordon, 1);
  });

  test('every kind of target can have a cluster restore, not just a k8s one', () => {
    // The restore method is a choice of its own: an ssh jump host whose restore
    // brings a cluster back needs its own API URL and token.
    const cfg = ssh({
      restore_enabled: 1, restore_kind: 'k8s',
      restore_api_url: 'https://10.0.0.1:6443', restore_uncordon: 1
    });
    assert.equal(typeof cfg, 'object', typeof cfg === 'string' ? cfg : '');
    assert.equal(cfg.restore_inherit, 0);
  });
});

// ---- which restores answer 202 ----

describe('isSequenceRestore', () => {
  test('a target with no restore never does', () => {
    assert.equal(isSequenceRestore('ssh', { restore_enabled: 0 }), false);
  });

  test('a wake always does — nothing answers a magic packet, so a wait follows', () => {
    assert.equal(isSequenceRestore('http', { restore_enabled: 1, restore_kind: 'wol', wol_mac: 'AA:BB:CC:DD:EE:FF' }),
      true);
  });

  test('anything that opens by polling always does, in either step', () => {
    assert.equal(isSequenceRestore('http', { restore_enabled: 1, restore_kind: 'k8s' }), true);
    for (const post_restore_kind of ['ssh', 'winrm', 'k8s']) {
      assert.equal(isSequenceRestore('http', { restore_enabled: 1, restore_kind: 'wol', post_restore_kind }),
        true, post_restore_kind);
    }
  });

  test('an http method does only when some safe probe is at hand', () => {
    // The restore request itself is never polled, so this turns on whether
    // anything else is safe to retry while waiting.
    const undo = (kind, over) => isSequenceRestore(kind,
      { restore_enabled: 1, restore_kind: 'http', restore_inherit: 1, auth_scheme: 'login', ...over });

    assert.equal(undo('http', {}), true, 'the inherited login, on the default 300s wait');
    assert.equal(undo('http', { restore_wait_seconds: 0 }), false, 'no budget to wait through');
    assert.equal(undo('http', { auth_scheme: 'bearer' }), false, 'a static scheme has no safe probe');

    // With its own connection the fallback is the target's own test, which an
    // ssh target has and a static-scheme http target does not.
    assert.equal(undo('ssh', { restore_inherit: 0 }), true);
    assert.equal(undo('http', { restore_inherit: 0, auth_scheme: 'bearer' }), false);
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
