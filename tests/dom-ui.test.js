import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, importFresh, click, flush } from './helpers/jsdom-env.js';

/**
 * The DOM-dependent half of public/scripts/dom.js. (The pure formatting helpers
 * are covered in tests/dom.test.js, which needs no browser.)
 *
 * Layout is out of reach here — jsdom renders nothing, so the help popover's
 * edge-flip and the tooltip's placement, both of which read
 * getBoundingClientRect(), cannot be asserted. Everything else can.
 */

const DOM = new URL('../public/scripts/dom.js', import.meta.url).href;

let env;
let dom;

async function boot(html, url) {
  env = setupDom(html, url);
  dom = await importFresh(DOM);
  return env.document;
}

beforeEach(async () => { await boot(); });
afterEach(() => env.cleanup());

const key = (name) =>
  env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

// ---------- el ----------

describe('el', () => {
  test('sets class and arbitrary attributes', () => {
    const node = dom.el('a', { class: 'btn ghost', href: '/x', title: 'go' });
    assert.equal(node.tagName, 'A');
    assert.equal(node.className, 'btn ghost');
    assert.equal(node.getAttribute('href'), '/x');
    assert.equal(node.getAttribute('title'), 'go');
  });

  test('appends element and text children, skipping null', () => {
    const node = dom.el('div', {}, 'a', null, dom.el('span', {}, 'b'), undefined, 'c');
    assert.equal(node.childNodes.length, 3);
    assert.equal(node.textContent, 'abc');
  });

  test('text children are text, not markup — a name cannot inject elements', () => {
    // Row values come from user-supplied names; this is why children are
    // appended rather than assigned through innerHTML.
    const node = dom.el('td', {}, '<img src=x onerror=alert(1)>');
    assert.equal(node.querySelector('img'), null);
    assert.equal(node.textContent, '<img src=x onerror=alert(1)>');
  });
});

test('clear empties a node', () => {
  const node = dom.el('div', {}, dom.el('span', {}, 'a'), 'b');
  assert.ok(node.childNodes.length > 0);
  dom.clear(node);
  assert.equal(node.childNodes.length, 0);
});

test('enabledPill reads as the on/off switch it is', () => {
  assert.equal(dom.enabledPill(1).textContent, 'ENABLED');
  assert.match(dom.enabledPill(1).className, /\bup\b/);
  assert.equal(dom.enabledPill(0).textContent, 'DISABLED');
  assert.match(dom.enabledPill(0).className, /\bdisabled\b/);
});

// ---------- toggleByData ----------

describe('toggleByData', () => {
  const MARKUP = `
    <form id="f">
      <div data-kind="ssh" id="a"></div>
      <div data-kind="winrm" id="b"></div>
      <div data-kind="k8s" id="c"></div>
    </form>
    <div data-kind="ssh" id="outside"></div>`;

  const shown = (id) => env.document.getElementById(id).style.display !== 'none';

  test('shows only what the chosen value names', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    dom.toggleByData(document.getElementById('f'), 'kind', 'winrm');

    assert.equal(shown('a'), false);
    assert.equal(shown('b'), true);
    assert.equal(shown('c'), false);
  });

  test('switching value moves the visible one, restoring what was hidden', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    const form = document.getElementById('f');

    dom.toggleByData(form, 'kind', 'ssh');
    assert.equal(shown('a'), true);

    dom.toggleByData(form, 'kind', 'k8s');
    assert.equal(shown('a'), false);
    assert.equal(shown('c'), true);
  });

  test('a value matching nothing hides everything, rather than throwing', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    dom.toggleByData(document.getElementById('f'), 'kind', 'nope');
    assert.deepEqual(['a', 'b', 'c'].map(shown), [false, false, false]);
  });

  test('scoped to the root it is given — the config page has two forms', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    dom.toggleByData(document.getElementById('f'), 'kind', 'winrm');

    assert.equal(shown('outside'), true, 'a node outside the root is left alone');
  });

  test('a space-separated list means "any of these"', async () => {
    // e.g. data-http="bearer basic" — one field that two schemes both need.
    const document = await boot(`<!doctype html><body><form id="f">
      <div data-http="bearer basic" id="shared"></div>
      <div data-http="login" id="only-login"></div>
    </form></body>`);
    const form = document.getElementById('f');

    dom.toggleByData(form, 'http', 'bearer');
    assert.equal(shown('shared'), true);
    assert.equal(shown('only-login'), false);

    dom.toggleByData(form, 'http', 'basic');
    assert.equal(shown('shared'), true, 'the second value in the list matches too');

    dom.toggleByData(form, 'http', 'login');
    assert.equal(shown('shared'), false);
    assert.equal(shown('only-login'), true);
  });

  test('a hyphenated attribute maps to its camelCase dataset key', async () => {
    // data-relay-ssh-auth -> dataset.relaySshAuth; getting this wrong would
    // silently hide every field it drives.
    const document = await boot(`<!doctype html><body><form id="f">
      <div data-relay-ssh-auth="password" id="pw"></div>
      <div data-relay-ssh-auth="key" id="k"></div>
    </form></body>`);

    dom.toggleByData(document.getElementById('f'), 'relay-ssh-auth', 'key');
    assert.equal(shown('pw'), false);
    assert.equal(shown('k'), true);
  });
});

// ---------- initCollapsible ----------

describe('initCollapsible', () => {
  const MARKUP = '<div id="head"><span class="help"><button class="help-btn">?</button></span></div><div id="body"></div>';

  function build(k = 'test') {
    const head = env.document.getElementById('head');
    const body = env.document.getElementById('body');
    return { section: dom.initCollapsible(k, head, body), head, body };
  }

  test('starts collapsed, and says so for assistive tech', async () => {
    await boot(`<!doctype html><body>${MARKUP}</body>`);
    const { head, body } = build();

    assert.equal(body.style.display, 'none');
    assert.equal(head.getAttribute('aria-expanded'), 'false');
  });

  test('clicking the header toggles it', async () => {
    await boot(`<!doctype html><body>${MARKUP}</body>`);
    const { head, body } = build();

    click(head);
    assert.equal(body.style.display, '');
    assert.equal(head.getAttribute('aria-expanded'), 'true');

    click(head);
    assert.equal(body.style.display, 'none');
  });

  test('the choice survives a reload, per key', async () => {
    await boot(`<!doctype html><body>${MARKUP}</body>`);
    build('remembered');
    click(env.document.getElementById('head'));
    assert.equal(env.window.localStorage.getItem('flatline:collapsed:remembered'), '0');

    // Same key again: opens expanded this time.
    const again = dom.initCollapsible('remembered',
      env.document.getElementById('head'), env.document.getElementById('body'));
    assert.equal(env.document.getElementById('body').style.display, '');
    assert.ok(again);

    // A different section keeps its own default.
    const other = env.document.createElement('div');
    dom.initCollapsible('separate', env.document.createElement('div'), other);
    assert.equal(other.style.display, 'none');
  });

  test('expand() and collapse() drive it from outside', async () => {
    await boot(`<!doctype html><body>${MARKUP}</body>`);
    const { section, body } = build();

    section.expand();
    assert.equal(body.style.display, '');
    section.collapse();
    assert.equal(body.style.display, 'none');
  });

  test('the "?" beside the title is not part of the fold control', async () => {
    // initHelp is delegated from the document, so its stopPropagation lands too
    // late — the collapsible has to skip these clicks itself.
    await boot(`<!doctype html><body>${MARKUP}</body>`);
    const { body } = build();

    click(env.document.querySelector('.help-btn'));
    assert.equal(body.style.display, 'none', 'still collapsed');
  });
});

// ---------- initTabs ----------

describe('initTabs', () => {
  const MARKUP = `
    <div id="tabs">
      <button role="tab" data-tab="general">General</button>
      <button role="tab" data-tab="relays">Relays</button>
    </div>
    <div data-panel="general">g</div>
    <div data-panel="relays">r</div>`;

  const panel = (name) => env.document.querySelector(`[data-panel="${name}"]`);

  test('shows the first tab by default', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    dom.initTabs('cfg', document.getElementById('tabs'));

    assert.equal(panel('general').hidden, false);
    assert.equal(panel('relays').hidden, true);
  });

  test('clicking a tab reveals its panel and marks it selected', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    dom.initTabs('cfg', document.getElementById('tabs'));

    click(document.querySelector('[data-tab="relays"]'));

    assert.equal(panel('relays').hidden, false);
    assert.equal(panel('general').hidden, true);
    assert.equal(document.querySelector('[data-tab="relays"]').getAttribute('aria-selected'), 'true');
    assert.equal(document.querySelector('[data-tab="general"]').getAttribute('aria-selected'), 'false');
  });

  test('panels are hidden, never detached, so getElementById still finds their fields', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    dom.initTabs('cfg', document.getElementById('tabs'));

    // The config page looks up elements on load whichever tab happens to be open.
    assert.ok(document.querySelector('[data-panel="relays"]').isConnected);
  });

  test('a URL hash deep-links to a tab, beating the remembered choice', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`, 'http://localhost/config#relays');
    env.window.localStorage.setItem('flatline:tab:cfg', 'general');
    dom.initTabs('cfg', document.getElementById('tabs'));

    assert.equal(panel('relays').hidden, false, '/config#relays opens the Relays tab');
  });

  test('an unknown name falls back to the first tab rather than showing nothing', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`, 'http://localhost/config#nope');
    dom.initTabs('cfg', document.getElementById('tabs'));

    assert.equal(panel('general').hidden, false);
  });

  test('arrow keys move between tabs and wrap around', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    const tablist = document.getElementById('tabs');
    dom.initTabs('cfg', tablist);

    const arrow = (k) => tablist.dispatchEvent(
      new env.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

    arrow('ArrowRight');
    assert.equal(panel('relays').hidden, false);

    arrow('ArrowRight'); // past the end, back to the first
    assert.equal(panel('general').hidden, false);

    arrow('ArrowLeft'); // before the start, round to the last
    assert.equal(panel('relays').hidden, false);
  });
});

// ---------- initDirtyNote ----------

describe('initDirtyNote', () => {
  const MARKUP = '<form id="f"><input name="a"></form><span id="note"></span><span id="saved"></span>';

  test('typing raises the note and clears any "Saved ✓"', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    const form = document.getElementById('f');
    const note = document.getElementById('note');
    const saved = document.getElementById('saved');
    saved.textContent = 'Saved ✓';

    dom.initDirtyNote(form, note, saved);
    form.dispatchEvent(new env.window.Event('input', { bubbles: true }));

    assert.equal(note.textContent, 'Unsaved changes');
    assert.equal(saved.textContent, '', 'the old confirmation is stale now');
  });

  test('filling a form programmatically stays clean', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    const form = document.getElementById('f');
    const note = document.getElementById('note');
    dom.initDirtyNote(form, note);

    // Setting .value fires no input event — this is what fill() does.
    form.elements.namedItem('a').value = 'from the server';
    assert.equal(note.textContent, '');
  });

  test('markClean wipes the note again', async () => {
    const document = await boot(`<!doctype html><body>${MARKUP}</body>`);
    const form = document.getElementById('f');
    const note = document.getElementById('note');
    const dirty = dom.initDirtyNote(form, note);

    form.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    assert.equal(note.textContent, 'Unsaved changes');

    dirty.markClean();
    assert.equal(note.textContent, '');
  });
});

// ---------- dialogs ----------

describe('dialogs', () => {
  const overlay = () => env.document.querySelector('.modal-overlay');
  const buttons = () => [...env.document.querySelectorAll('.modal-actions button')];

  test('confirmDialog resolves true on confirm and false on cancel', async () => {
    const yes = dom.confirmDialog({ title: 'Delete?', body: 'sure?' });
    await flush();
    click(buttons()[1]);
    assert.equal(await yes, true);
    assert.equal(overlay(), null);

    const no = dom.confirmDialog({ title: 'Delete?', body: 'sure?' });
    await flush();
    click(buttons()[0]);
    assert.equal(await no, false);
  });

  test('alertDialog has a single dismiss button', async () => {
    const done = dom.alertDialog({ title: 'Done', body: 'it worked' });
    await flush();

    assert.equal(buttons().length, 1);
    assert.equal(buttons()[0].textContent, 'OK');
    click(buttons()[0]);
    assert.equal(await done, true);
  });

  test('Escape cancels and Enter confirms', async () => {
    const escaped = dom.confirmDialog({ body: 'x' });
    await flush();
    key('Escape');
    assert.equal(await escaped, false);

    const entered = dom.confirmDialog({ body: 'x' });
    await flush();
    key('Enter');
    assert.equal(await entered, true);
  });

  test('clicking the backdrop cancels, but clicking the dialog does not', async () => {
    const result = dom.confirmDialog({ body: 'x' });
    await flush();

    click(env.document.querySelector('.modal'));
    await flush();
    assert.ok(overlay(), 'still open — the click was inside the dialog');

    click(overlay());
    assert.equal(await result, false);
  });

  test('body accepts several paragraphs, and danger marks the confirm button', async () => {
    dom.confirmDialog({ title: 'Reset?', body: ['line one', 'line two'], danger: true });
    await flush();

    assert.equal(env.document.querySelectorAll('.modal-body').length, 2);
    assert.match(buttons()[1].className, /danger-ghost/);
  });
});

// ---------- wireFileUpload ----------

test('wireFileUpload reads a picked file into the target field', async () => {
  const document = await boot(
    '<!doctype html><body><button id="b"></button><input type="file" id="file"><textarea id="t"></textarea></body>');
  const button = document.getElementById('b');
  const input = document.getElementById('file');
  const target = document.getElementById('t');

  let loaded = 0;
  dom.wireFileUpload(button, input, target, () => { loaded += 1; });

  // jsdom cannot populate a real file picker, so stand a File in for one.
  const file = new env.window.File(['-----BEGIN KEY-----'], 'id_rsa', { type: 'text/plain' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await flush(10);

  assert.equal(target.value, '-----BEGIN KEY-----', 'contents land in the field');
  assert.equal(loaded, 1, 'the onLoad callback ran');
  assert.equal(input.value, '', 're-picking the same file must fire change again');
});
