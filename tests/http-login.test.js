import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockTargets, MOCK_LOGIN } from '../dev/mock-targets.js';
import { testTarget, runStep, restoreStep } from '../server/connectors.js';

// The http target's 'login' auth scheme: a first request trades credentials for
// a per-session token (a CSRF token, typically), which the real request carries.
//
// Driven through connectors.js against dev/mock-targets.js, which hands the
// token back in a body field, a response header and a cookie all at once — so
// each extraction mode has something real to read, and /protected refuses
// anything not carrying a matching token/session pair.
//
// How the config is validated lives in server/index.js and has no test seam yet
// (see BACKLOG.md); this file is about the behaviour.

let mock;
let base;

before(async () => {
  mock = await startMockTargets(0); // ephemeral port
  base = `http://127.0.0.1:${mock.address().port}`;
});
after(() => mock.close());

const secrets = { login_password: MOCK_LOGIN.password };

/** A target whose trigger request is the token-protected route. */
function target(over = {}) {
  return {
    url: `${base}/protected`,
    method: 'POST',
    auth_scheme: 'login',
    login_url: `${base}/login`,
    login_method: 'POST',
    login_auth: 'body',
    login_content_type: 'json',
    login_body: '{"username":"{username}","password":"{password}"}',
    login_username: MOCK_LOGIN.username,
    token_source: 'json',
    token_json_path: 'data.csrf_token',
    token_header: 'X-CSRF-Token',
    send_cookies: 1,
    ...over
  };
}

describe('reading the token out of the login response', () => {
  test('from a dotted path into the response body', async () => {
    const result = await runStep('http', target(), secrets);
    assert.equal(result.ok, true, result.message);
    // Both halves are reported: authenticating and then being refused is a
    // different problem from not authenticating at all.
    assert.match(result.message, /authenticated at .*\/login; POST .*\/protected -> 200/);
  });

  test('from a response header', async () => {
    const result = await runStep('http',
      target({ token_source: 'header', token_response_header: 'X-CSRF-Token' }), secrets);
    assert.equal(result.ok, true, result.message);
  });

  test('from a cookie the login set', async () => {
    const result = await runStep('http',
      target({ token_source: 'cookie', token_cookie: 'csrf_token' }), secrets);
    assert.equal(result.ok, true, result.message);
  });

  test('a path that matches nothing fails with the path named', async () => {
    const result = await runStep('http', target({ token_json_path: 'data.nope' }), secrets);
    assert.equal(result.ok, false);
    assert.match(result.message, /logged in at .*, but nothing at "data\.nope" in the response body/);
  });

  test('a response header that is absent fails with the header named', async () => {
    const result = await runStep('http',
      target({ token_source: 'header', token_response_header: 'X-Absent' }), secrets);
    assert.equal(result.ok, false);
    assert.match(result.message, /no "X-Absent" header in the response/);
  });

  test('a cookie that is absent fails with the cookie named', async () => {
    const result = await runStep('http',
      target({ token_source: 'cookie', token_cookie: 'absent' }), secrets);
    assert.equal(result.ok, false);
    assert.match(result.message, /the response set no "absent" cookie/);
  });
});

describe('the session the token belongs to', () => {
  test('the cookies the login set are sent back', async () => {
    const result = await runStep('http', target({ send_cookies: 1 }), secrets);
    assert.equal(result.ok, true, result.message);
  });

  test('a token with no session is refused — so the cookie really is carried', async () => {
    // Proves the previous test passes because of the cookie jar rather than in
    // spite of it: /protected wants a matching pair.
    const result = await runStep('http', target({ send_cookies: 0 }), secrets);
    assert.equal(result.ok, false);
    assert.match(result.message, /no session cookie/);
  });

  test('a session cookie can be built from a field in the response body', async () => {
    // Some services return the session in the body and never send a Set-Cookie,
    // leaving the client to assemble the header itself.
    const result = await runStep('http', target({
      send_cookies: 0,
      session_cookie_name: 'session',
      session_cookie_json_path: 'data.ticket'
    }), secrets);
    assert.equal(result.ok, true, result.message);
  });

  test('a built cookie whose path matches nothing fails with both names', async () => {
    const result = await runStep('http', target({
      session_cookie_name: 'session',
      session_cookie_json_path: 'data.absent'
    }), secrets);
    assert.equal(result.ok, false);
    assert.match(result.message, /nothing at "data\.absent" .* to build the "session" cookie from/);
  });
});

describe('handing over the credentials', () => {
  test('a form-encoded login body', async () => {
    const result = await runStep('http', target({
      login_content_type: 'form',
      login_body: 'username={username}&password={password}'
    }), secrets);
    assert.equal(result.ok, true, result.message);
  });

  test('basic auth instead of a body', async () => {
    const result = await runStep('http',
      target({ login_auth: 'basic', login_body: '' }), secrets);
    assert.equal(result.ok, true, result.message);
  });

  test('wrong credentials fail with the login status, not the trigger request', async () => {
    const result = await runStep('http', target(), { login_password: 'wrong' });
    assert.equal(result.ok, false);
    assert.match(result.message, /login POST .*\/login -> 401/);
    assert.doesNotMatch(result.message, /protected/);
  });

  // The substitution escapes for the body's own syntax. Without it a password
  // containing a quote or an ampersand would not merely fail — it would change
  // the shape of the request it was pasted into.
  const AWKWARD = 'p"a\\s&s=w?o rd';

  test('a password with JSON metacharacters survives a JSON body', async () => {
    const result = await runStep('http', target({
      url: `${base}/login-echo`, login_url: `${base}/login-echo`
    }), { login_password: AWKWARD });
    assert.equal(result.ok, true, result.message);

    // Ask the echo route directly for what it parsed.
    const res = await fetch(`${base}/login-echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: MOCK_LOGIN.username, password: AWKWARD })
    });
    assert.equal((await res.json()).seen.password, AWKWARD);
  });

  test('a password with form metacharacters survives a form body', async () => {
    // Round-trip through the connector: the login succeeds and the token is
    // usable, which it would not be if the body had been split by the & or =.
    const result = await runStep('http', target({
      login_url: `${base}/login-echo`,
      login_content_type: 'form',
      login_body: 'username={username}&password={password}'
    }), { login_password: AWKWARD });
    assert.equal(result.ok, true, result.message);
  });
});

describe('testing a login target', () => {
  test('logs in and does not send the trigger request', async () => {
    const result = await testTarget('http', target(), secrets);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /the trigger request was not sent/);
    assert.doesNotMatch(result.message, /protected/);
  });

  test('a static-scheme target still tests by sending its real request', async () => {
    // Unchanged behaviour, and the reason the login scheme's safe test matters:
    // there is no no-op to send for these.
    const result = await testTarget('http', { url: `${base}/up`, method: 'POST', auth_scheme: 'none' }, {});
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /POST .*\/up -> 200/);
  });
});

describe('restore', () => {
  /** A login target restoring over http, reusing its own connection — the login
   *  is what the wait polls, so it is the one that has to be inherited. */
  const undo = (over = {}) => target({
    restore_enabled: 1, restore_kind: 'http', restore_inherit: 1,
    restore_method: 'POST', ...over
  });

  test('sends the configured undo request', async () => {
    const result = await restoreStep('http',
      undo({ restore_url: `${base}/protected`, restore_wait_seconds: 0 }), secrets);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /authenticated at .*; POST .*\/protected -> 200/);
  });

  test('says so when there is no restore configured', async () => {
    const result = await restoreStep('http', target(), secrets);
    assert.equal(result.ok, false);
    assert.match(result.message, /no restore configured/);
  });

  test('waits for the login to start answering, then sends the request', async () => {
    // The service refuses logins for its first 500ms — auto-restore fires the
    // moment the group reports healthy, which is normally before it is back. The
    // budget is what caps the sleep between attempts, so keep it short: the first
    // attempt fails, the second (a budget later) succeeds.
    const result = await restoreStep('http', undo({
      login_url: `${base}/login-after?ms=500`,
      restore_url: `${base}/protected`,
      restore_wait_seconds: 2
    }), secrets);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /authenticated at .*; POST .*\/protected -> 200/);
  });

  test('gives up with the budget and the last failure in the message', async () => {
    const result = await restoreStep('http', undo({
      login_url: `${base}/login-after?ms=600000`,
      restore_url: `${base}/protected`,
      restore_wait_seconds: 1
    }), secrets);
    assert.equal(result.ok, false);
    assert.match(result.message, /the login did not answer within 1s/);
    assert.match(result.message, /503/);
  });

  test('a static-scheme target has no probe, so it sends its request once', async () => {
    const result = await restoreStep('http', {
      url: `${base}/up`, method: 'POST', auth_scheme: 'none',
      restore_enabled: 1, restore_kind: 'http', restore_inherit: 1,
      restore_url: `${base}/up`, restore_method: 'POST', restore_wait_seconds: 300
    }, {});
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /POST .*\/up -> 200/);
  });
});

// Requests moved from fetch() to node:http/https so a target could carry its own
// TLS policy. fetch followed redirects, so these must keep doing so.
describe('the transport', () => {
  test('follows a redirect, turning a 301 into a GET', async () => {
    const seen = [];
    const srv = await redirectServer(seen);
    try {
      const result = await runStep('http',
        { url: `${srv.base}/r301`, method: 'POST', auth_scheme: 'none' }, {});
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(seen, ['POST /r301', 'GET /final']);
    } finally { srv.close(); }
  });

  test('repeats the request unchanged on a 307', async () => {
    const seen = [];
    const srv = await redirectServer(seen);
    try {
      const result = await runStep('http',
        { url: `${srv.base}/r307`, method: 'POST', auth_scheme: 'none' }, {});
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(seen, ['POST /r307', 'POST /final']);
    } finally { srv.close(); }
  });

  test('a redirect loop fails rather than reporting the 302 as success', async () => {
    const seen = [];
    const srv = await redirectServer(seen);
    try {
      const result = await runStep('http',
        { url: `${srv.base}/loop`, method: 'GET', auth_scheme: 'none' }, {});
      assert.equal(result.ok, false);
      assert.match(result.message, /too many redirects/);
    } finally { srv.close(); }
  });

  test('an invalid URL is named rather than thrown', async () => {
    const result = await runStep('http', { url: 'not-a-url', method: 'GET', auth_scheme: 'none' }, {});
    assert.equal(result.ok, false);
    assert.match(result.message, /invalid URL "not-a-url"/);
  });

  test('a request that never answers stops at its timeout', async () => {
    const result = await runStep('http', { url: `${base}/hang`, method: 'GET', auth_scheme: 'none' }, {}, 800);
    assert.equal(result.ok, false);
    assert.equal(result.message, 'timeout');
  });
});

async function redirectServer(seen) {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const to = { '/r301': 301, '/r307': 307, '/loop': 302 }[req.url];
    if (to) {
      res.writeHead(to, { location: req.url === '/loop' ? '/loop' : '/final' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

// A target's TLS policy is a per-URL fact: reached through a reverse proxy the
// certificate is trusted, on a bare IP it is the appliance's own self-signed one.
//
// Needs a self-signed certificate, which Node cannot mint, so these are skipped
// where openssl is not usable — see BACKLOG.md.
describe('TLS verification', () => {
  let pem = null;
  let tlsBase = null;
  let tlsSrv = null;

  before(async () => {
    try {
      const dir = mkdtempSync(path.join(tmpdir(), 'flatline-tls-'));
      const keyFile = path.join(dir, 'k.pem');
      const crtFile = path.join(dir, 'c.pem');
      // A minimal config: some system openssl.cnf files carry a v3_ca section
      // that -addext then rejects.
      const cnf = path.join(dir, 'openssl.cnf');
      writeFileSync(cnf, '[req]\ndistinguished_name=dn\n[dn]\n');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyFile, '-out', crtFile, '-days', '2', '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1', '-config', cnf], { stdio: 'ignore' });
      pem = readFileSync(crtFile, 'utf8');
      tlsSrv = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(crtFile) }, (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
      }).listen(0, '127.0.0.1');
      await new Promise((r) => tlsSrv.once('listening', r));
      tlsBase = `https://127.0.0.1:${tlsSrv.address().port}/x`;
    } catch {
      pem = null; // openssl unavailable — the tests below skip
    }
  });
  after(() => tlsSrv?.close());

  const reason = 'needs openssl to mint a self-signed certificate';

  test('an untrusted certificate is refused by default', async (t) => {
    if (!pem) return t.skip(reason);
    const result = await runStep('http', { url: tlsBase, method: 'GET', auth_scheme: 'none' }, {});
    assert.equal(result.ok, false);
    assert.match(result.message, /self-signed certificate/);
  });

  test('insecure_tls accepts it anyway', async (t) => {
    if (!pem) return t.skip(reason);
    const result = await runStep('http',
      { url: tlsBase, method: 'GET', auth_scheme: 'none', insecure_tls: 1 }, {});
    assert.equal(result.ok, true, result.message);
  });

  test('a supplied CA verifies it properly', async (t) => {
    if (!pem) return t.skip(reason);
    const result = await runStep('http',
      { url: tlsBase, method: 'GET', auth_scheme: 'none', ca_cert: pem }, {});
    assert.equal(result.ok, true, result.message);
  });

  test('the wrong CA still refuses it', async (t) => {
    if (!pem) return t.skip(reason);
    const result = await runStep('http', {
      url: tlsBase, method: 'GET', auth_scheme: 'none',
      ca_cert: '-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n'
    }, {});
    assert.equal(result.ok, false);
    assert.match(result.message, /certificate/);
  });

  test('the login request honours the same policy', async (t) => {
    if (!pem) return t.skip(reason);
    // The login is a separate request, so it needs the policy applied too —
    // otherwise a self-signed target could never authenticate.
    const result = await runStep('http', target({
      url: tlsBase, login_url: tlsBase, insecure_tls: 1,
      token_source: 'header', token_response_header: 'X-Absent'
    }), secrets);
    // The login connects (so TLS was accepted) and fails only on the token.
    assert.equal(result.ok, false);
    assert.match(result.message, /logged in at .*, but no "X-Absent" header/);
  });
});
