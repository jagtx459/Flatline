import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, importFresh, click, flush } from './helpers/jsdom-env.js';

/**
 * public/scripts/header.js — the site header every page but login shares, and in
 * particular the phone menu it builds: below 720px the nav tabs and the Log out
 * button move into a dropdown behind a hamburger, and back out again when the
 * window widens.
 *
 * The move is the part worth pinning down. The tabs and the button are *moved*,
 * not copied, so the page must still hold exactly one nav and one
 * #header-logout at either width — a copy would give the login click handler two
 * buttons to disagree about, and duplicate the nav for a screen reader.
 *
 * jsdom has no layout, so a real width query never matches. window.matchMedia is
 * stubbed below instead, which is the more useful harness anyway: it can flip
 * the breakpoint mid-test and fire the change event, which is what exercises the
 * move back and forth.
 */

const HEADER = new URL('../public/scripts/header.js', import.meta.url).href;

/** The query header.js watches. Kept in step with NARROW there. */
const NARROW = '(max-width: 720px)';

const HTML = `<!doctype html><html><body><div class="container">
  <header class="site">
    <span class="brand">FLATLINE</span>
    <nav>
      <a href="/" class="active">Dashboard</a>
      <a href="/flatline">Flatline</a>
      <a href="/actions">Actions</a>
      <a href="/config">Config</a>
    </nav>
    <div class="header-actions">
      <span class="header-version" id="header-version"></span>
      <button type="button" class="icon-link" id="header-theme"></button>
      <button type="button" class="btn ghost small" id="header-logout" style="display:none">Log out</button>
    </div>
  </header>
</div></body></html>`;

const realFetch = globalThis.fetch;

let env;
let doc;
let media;
let authRequired;
let calls;

/**
 * Stands in for window.matchMedia. Returns a handle on the breakpoint list so a
 * test can flip it: `media.set(true)` widens/narrows and fires `change`, exactly
 * as a browser would on a resize or an orientation change.
 */
function stubMatchMedia(narrow) {
  const lists = new Map();
  env.window.matchMedia = (query) => {
    if (!lists.has(query)) {
      const listeners = new Set();
      lists.set(query, {
        media: query,
        // Only the breakpoint matters here; theme.js asks about
        // prefers-color-scheme and is happy with a steady "no".
        matches: query === NARROW ? narrow : false,
        addEventListener: (_type, fn) => listeners.add(fn),
        removeEventListener: (_type, fn) => listeners.delete(fn),
        fire(next) {
          this.matches = next;
          for (const fn of listeners) fn(this);
        }
      });
    }
    return lists.get(query);
  };
  return {
    set(next) {
      lists.get(NARROW).fire(next);
    }
  };
}

/** Imports header.js against the current DOM and boots it, as a page does. */
async function boot({ narrow = true, auth = true } = {}) {
  authRequired = auth;
  media = stubMatchMedia(narrow);
  const mod = await importFresh(HEADER);
  mod.initHeaderAuth();
  await flush();
  return mod;
}

const panel = () => doc.getElementById('header-menu');
const hamburger = () => doc.getElementById('header-menu-btn');

beforeEach(() => {
  env = setupDom(HTML);
  doc = env.document;
  calls = [];
  globalThis.fetch = async (path) => {
    calls.push(path);
    return {
      ok: true,
      status: 200,
      json: async () => (path === '/api/version'
        ? { version: '9.9.9' }
        : { auth_required: authRequired })
    };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  env.cleanup();
});

// ---------- where the nav lives ----------

describe('the phone menu', () => {
  test('narrow, the nav and Log out move into the dropdown', async () => {
    await boot({ narrow: true });

    assert.equal(panel().querySelectorAll('nav').length, 1, 'nav is in the panel');
    assert.equal(doc.querySelector('header.site > nav'), null, 'and no longer in the header');
    assert.equal(panel().querySelector('#header-logout')?.textContent, 'Log out');
    assert.equal(doc.querySelectorAll('nav').length, 1, 'moved, not copied');
    assert.equal(doc.querySelectorAll('#header-logout').length, 1, 'moved, not copied');
  });

  test('wide, they stay in the header and the panel holds only its rule', async () => {
    await boot({ narrow: false });

    assert.ok(doc.querySelector('header.site > nav'), 'nav sits in the header');
    assert.equal(panel().querySelector('nav'), null);
    assert.ok(doc.querySelector('.header-actions #header-logout'), 'Log out sits with the icons');
    assert.equal(doc.querySelectorAll('nav').length, 1);
  });

  test('the hamburger is built on every page, and the panel starts closed', async () => {
    await boot({ narrow: true });

    assert.ok(hamburger(), 'the button exists');
    assert.equal(hamburger().getAttribute('aria-controls'), 'header-menu');
    assert.equal(hamburger().getAttribute('aria-expanded'), 'false');
    assert.equal(panel().hidden, true);
  });

  test('nothing is built on a page with no nav, such as login', async () => {
    env.cleanup();
    env = setupDom('<!doctype html><html><body><header class="site"><span class="brand">F</span></header></body></html>');
    doc = env.document;
    await boot({ narrow: true });

    assert.equal(doc.getElementById('header-menu'), null);
    assert.equal(doc.getElementById('header-menu-btn'), null);
  });
});

// ---------- crossing the breakpoint ----------

describe('resizing across the breakpoint', () => {
  test('widening moves the nav back out and closes the menu', async () => {
    await boot({ narrow: true });
    click(hamburger());
    assert.equal(panel().hidden, false, 'open to begin with');

    media.set(false);

    assert.ok(doc.querySelector('header.site > nav'), 'nav returned to the header');
    assert.ok(doc.querySelector('.header-actions #header-logout'));
    assert.equal(panel().hidden, true, 'a menu left open must not linger');
    assert.equal(hamburger().getAttribute('aria-expanded'), 'false');
  });

  test('back and forth keeps exactly one nav and one Log out', async () => {
    await boot({ narrow: false });

    for (let i = 0; i < 3; i++) {
      media.set(true);
      media.set(false);
    }

    assert.equal(doc.querySelectorAll('nav').length, 1);
    assert.equal(doc.querySelectorAll('#header-logout').length, 1);
    assert.ok(doc.querySelector('header.site > nav'));
  });

  test('the Log out button keeps working after being moved', async () => {
    await boot({ narrow: true });
    // A moved node keeps its listeners; this is the one that would strand a
    // user on a page they can no longer leave if the button were re-created.
    // The redirect that follows is jsdom's blind spot (it implements no
    // navigation), so the request the handler makes is what gets asserted.
    click(panel().querySelector('#header-logout'));
    await flush();

    assert.ok(calls.includes('/api/logout'), 'the click still reaches logout()');
  });
});

// ---------- opening and closing ----------

describe('opening and closing the menu', () => {
  test('the hamburger toggles the panel and its aria-expanded', async () => {
    await boot({ narrow: true });

    click(hamburger());
    assert.equal(panel().hidden, false);
    assert.equal(hamburger().getAttribute('aria-expanded'), 'true');

    click(hamburger());
    assert.equal(panel().hidden, true);
    assert.equal(hamburger().getAttribute('aria-expanded'), 'false');
  });

  test('a click outside closes it, and one inside does not', async () => {
    await boot({ narrow: true });
    click(hamburger());

    click(panel().querySelector('nav a'));
    assert.equal(panel().hidden, false, 'a tap on a nav link is not "outside"');

    click(doc.querySelector('.brand'));
    assert.equal(panel().hidden, true);
    assert.equal(hamburger().getAttribute('aria-expanded'), 'false');
  });

  test('Escape closes it', async () => {
    await boot({ narrow: true });
    click(hamburger());

    doc.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(panel().hidden, true);
    assert.equal(hamburger().getAttribute('aria-expanded'), 'false');
  });
});

// ---------- the separator above Log out ----------

describe('the menu separator', () => {
  test('it is shown while a login is required', async () => {
    await boot({ narrow: true, auth: true });

    assert.equal(doc.getElementById('header-menu-sep').style.display, '');
    assert.equal(doc.getElementById('header-logout').style.display, '');
  });

  test('with no login required, the rule goes with the button it divides', async () => {
    await boot({ narrow: true, auth: false });

    assert.equal(doc.getElementById('header-menu-sep').style.display, 'none');
    assert.equal(doc.getElementById('header-logout').style.display, 'none');
  });
});
