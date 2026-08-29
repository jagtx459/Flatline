import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDom, importFresh, flush } from './helpers/jsdom-env.js';

/**
 * public/scripts/login.js — the only page reachable without a session: it asks
 * whether a login is even required, and takes the password if one is.
 *
 * Everything this module does ends in a redirect, and jsdom implements no
 * navigation — assigning location.href there does nothing and logs a "not
 * implemented" error. Since the redirect *is* the behaviour under test (landing
 * here with no password set must not strand anyone on a login form they cannot
 * fill in), `location` is replaced with a plain recorder before the import. The
 * modules reach for it bare, so it resolves to the one on globalThis.
 *
 * pathname stays '/login' on that recorder, because api.js branches on it: a 401
 * anywhere else bounces to this page, and here it must surface as an error on
 * the form instead — which is what makes a wrong password readable.
 *
 * The login page has no nav and no Log out button, so initHeaderAuth() does far
 * less here than elsewhere; the one assertion about that is below, against the
 * real markup rather than header-ui.test.js's stand-in for it.
 */

const LOGIN = new URL('../public/scripts/login.js', import.meta.url).href;
const HTML = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');

const realFetch = globalThis.fetch;

let env;
let doc;
let calls;
let where;

/** Stands in for window.location, so a redirect is something to assert on
 *  rather than a jsdom blind spot. */
function recordLocation() {
  where = { href: '/login', pathname: '/login', search: '' };
  globalThis.location = where;
}

/**
 * Stands up the login page. `auth` is what /api/auth answers — or a function, to
 * make that check fail; `onLogin` answers POST /api/login, defaulting to success.
 */
async function boot({ auth = { auth_required: true, authenticated: false }, onLogin } = {}) {
  env = setupDom(HTML, 'http://localhost/login');
  doc = env.document;
  recordLocation();

  calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    if (path === '/api/login') {
      return onLogin ? onLogin() : { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (path === '/api/version') return { ok: true, status: 200, json: async () => ({ version: '1.0.0' }) };
    if (path === '/api/auth') {
      if (typeof auth === 'function') return auth();
      return { ok: true, status: 200, json: async () => auth };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await importFresh(LOGIN);
  await settle();
  return doc;
}

const settle = () => flush(6);

afterEach(() => {
  env.cleanup();
  globalThis.fetch = realFetch;
});

const paths = (method = 'GET') => calls.filter((c) => c.method === method).map((c) => c.path);
const sent = (method) => calls.find((c) => c.method === method)?.body;

const form = () => doc.getElementById('login-form');
const password = () => form().elements.namedItem('password');
const error = () => doc.getElementById('login-error');
const submitBtn = () => doc.getElementById('login-submit');

const submit = () =>
  form().dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));

// ---------- landing here ----------

describe('landing on the login page', () => {
  test('with a password set, the form is waiting and nothing has moved', async () => {
    await boot();

    assert.deepEqual(paths(), ['/api/version', '/api/auth']);
    assert.equal(where.href, '/login', 'stayed put');
    assert.equal(submitBtn().disabled, false);
    assert.equal(error().textContent, '');
  });

  test('with no password set, it goes straight to the dashboard', async () => {
    await boot({ auth: { auth_required: false, authenticated: false } });

    assert.equal(where.href, '/',
      'an open instance must not strand anyone on a form they cannot fill in');
  });

  test('with a session already in hand, it goes straight to the dashboard', async () => {
    await boot({ auth: { auth_required: true, authenticated: true } });
    assert.equal(where.href, '/');
  });

  test('a failed auth check leaves the form up rather than guessing', async () => {
    await boot({ auth: () => { throw new Error('network down'); } });

    assert.equal(where.href, '/login');
    assert.ok(form(), 'the password form is still there to try');
    assert.equal(error().textContent, '',
      'and the failure is swallowed — it is not the user\'s problem to solve');
  });

  test('the header builds no phone menu here, because there is no nav to put in one', async () => {
    await boot();

    assert.equal(doc.getElementById('header-menu'), null);
    assert.equal(doc.getElementById('header-menu-btn'), null);
    assert.equal(doc.getElementById('header-logout'), null, 'and nothing to log out of yet');
    assert.equal(doc.getElementById('header-version').textContent, 'v1.0.0',
      'the version badge is on every page, this one included');
  });
});

// ---------- logging in ----------

describe('logging in', () => {
  test('the password is sent, and a good one lands on the dashboard', async () => {
    await boot();
    password().value = 'hunter22';

    submit();
    await settle();

    assert.deepEqual(paths('POST'), ['/api/login']);
    assert.deepEqual(sent('POST'), { password: 'hunter22' });
    assert.equal(where.href, '/');
  });

  test('the button locks while the request is in flight, so it cannot be sent twice', async () => {
    let release;
    await boot({ onLogin: () => new Promise((resolve) => { release = resolve; }) });

    password().value = 'hunter22';
    submit();
    await settle();
    assert.equal(submitBtn().disabled, true);

    release({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await settle();
    assert.equal(where.href, '/');
  });

  test('a wrong password is reported on the form, and the button comes back', async () => {
    await boot({
      onLogin: () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid password' }) })
    });
    password().value = 'wrong';

    submit();
    await settle();

    assert.equal(error().textContent, 'invalid password');
    assert.equal(submitBtn().disabled, false, 'so it can be tried again');
    assert.equal(where.href, '/login', 'and a 401 here does not bounce back to this same page');
  });

  test('a second attempt clears the first one\'s error', async () => {
    let fail = true;
    await boot({
      onLogin: () => (fail
        ? { ok: false, status: 401, json: async () => ({ error: 'invalid password' }) }
        : { ok: true, status: 200, json: async () => ({ ok: true }) })
    });

    password().value = 'wrong';
    submit();
    await settle();
    assert.equal(error().textContent, 'invalid password');

    fail = false;
    password().value = 'hunter22';
    submit();
    await settle();

    assert.equal(error().textContent, '');
    assert.equal(where.href, '/');
  });

  test('a login that never reaches the server is reported the same way', async () => {
    await boot({ onLogin: () => { throw new Error('network down'); } });
    password().value = 'hunter22';

    submit();
    await settle();

    assert.equal(error().textContent, 'network down');
    assert.equal(submitBtn().disabled, false);
  });

  test('a rejection carrying no message still says something', async () => {
    await boot({ onLogin: () => ({ ok: false, status: 500, json: async () => null }) });
    password().value = 'hunter22';

    submit();
    await settle();
    assert.equal(error().textContent, 'request failed (500)');
  });
});
