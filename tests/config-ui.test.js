import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDom, importFresh, click, flush } from './helpers/jsdom-env.js';

/**
 * public/scripts/config.js — the Config page: three sub-tabs over notification
 * channels, the general settings (retention, site URL, encryption key, site
 * access, backup/restore) and the wake-on-LAN relays.
 *
 * Same harness as flatline-ui.test.js: the module binds to static markup at
 * module scope, so the real public/config.html is loaded into jsdom and the
 * import is what boots the page. Mock timers stand in for the clock here — this
 * page re-reads its channels every 20 seconds, so a test process would never
 * exit otherwise, and the "Saved ✓" notes clear themselves on a timer that is
 * worth asserting rather than waiting out.
 *
 * Two jsdom blind spots this page runs into, both stubbed per-test where they
 * come up rather than globally:
 *
 *  - URL.createObjectURL is not implemented, and neither is navigation, so the
 *    anchor saveBlob() clicks cannot actually download. What is asserted is the
 *    Blob that would have been saved and the filename it was given.
 *  - The site header comes with the page, so every boot also fetches
 *    /api/version and /api/auth. `paths()` drops those; header.js has its own
 *    suite.
 */

const CONFIG = new URL('../public/scripts/config.js', import.meta.url).href;
const HTML = readFileSync(new URL('../public/config.html', import.meta.url), 'utf8');

const realFetch = globalThis.fetch;

let env;
let doc;
let data;
let calls;

// ---------- fixtures (shapes mirror the /api/config/* and /api/settings routes) ----------

function channel(over = {}) {
  return {
    id: 1, name: 'Phone', kind: 'ntfy', enabled: 1,
    config: { events: ['endpoint_down'], server_url: 'https://ntfy.sh', topic: 'flatline' },
    secret_fields: [], last_result: null,
    ...over
  };
}

function relay(over = {}) {
  return {
    id: 1, name: 'VLAN20', kind: 'ssh', enabled: 1,
    config: { host: '10.1.20.10', port: 22, username: 'root', auth_method: 'password' },
    wake_command: 'wakeonlan {mac}', network: '10.1.20.0/24', secret_fields: [],
    ...over
  };
}

const settings = (over = {}) => ({
  retention_days: 14, base_url: '', base_url_source: 'settings', ...over
});
const keyStatus = (over = {}) => ({ source: 'file', encrypted_items: 0, ...over });
const security = (over = {}) => ({
  password_source: null, allowed_hosts: '', allowed_hosts_source: 'settings', ...over
});

// ---------- harness ----------

async function boot({
  channels = [], relays = [],
  settings: s = settings(), key = keyStatus(), securityConfig = security(),
  storage, session, url = 'http://localhost/config'
} = {}) {
  env = setupDom(HTML, url);
  doc = env.document;
  for (const [k, v] of Object.entries(storage ?? {})) env.window.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(session ?? {})) env.window.sessionStorage.setItem(k, v);

  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });

  data = { channels, relays, settings: s, key, security: securityConfig };
  calls = [];
  globalThis.fetch = defaultFetch;

  await importFresh(CONFIG);
  await settle();
  return doc;
}

const BODIES = {
  '/api/version': () => ({ version: '1.0.0' }),
  '/api/auth': () => ({ auth_required: false }),
  '/api/notifications': () => data.channels,
  '/api/relays': () => data.relays,
  '/api/settings': () => data.settings,
  '/api/config/key': () => data.key,
  '/api/config/security': () => data.security
};

/** The list routes answer reads; a write answers with the row it saved, carrying
 *  the id from its own URL — which is what initEntityForm re-fills the form from. */
function answer(path, init) {
  const method = init?.method ?? 'GET';
  if (method === 'GET' && BODIES[path]) return BODIES[path]();
  const id = Number(path.match(/\/(\d+)$/)?.[1]) || 1;
  return { id, name: 'saved', note: 'done' };
}

async function defaultFetch(path, init) {
  calls.push({ path, method: init?.method ?? 'GET', body: parseBody(init) });
  return { ok: true, status: 200, json: async () => answer(path, init) };
}

/** The backup upload sends a File rather than JSON, so it is kept as-is. */
function parseBody(init) {
  if (!init?.body) return null;
  return typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
}

const settle = () => flush(6);

afterEach(() => {
  mock.timers.reset();
  env.cleanup();
  globalThis.fetch = realFetch;
});

const paths = (method = 'GET') => calls
  .filter((c) => c.method === method && c.path !== '/api/version' && c.path !== '/api/auth')
  .map((c) => c.path);

const sent = (method) => calls.find((c) => c.method === method)?.body;

const submit = (form) =>
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));

const change = (node) => node.dispatchEvent(new env.window.Event('change', { bubbles: true }));

const text = (sel, root = doc) => root.querySelector(sel)?.textContent ?? null;

const rows = (id) => [...doc.querySelectorAll(`#${id} tbody tr`)]
  .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

function dialogButtons() {
  const buttons = [...doc.querySelectorAll('.modal-overlay .modal-actions button')];
  return buttons.length > 1 ? { cancel: buttons[0], confirm: buttons[1] } : { cancel: null, confirm: buttons[0] };
}

const rowButton = (tableId, label) =>
  [...doc.querySelectorAll(`#${tableId} tbody button`)].find((b) => b.textContent === label);

/** Answers one path differently, leaving every other request alone. */
function overrideFetch(match, replacement) {
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: parseBody(init) });
    if (match(path, init)) return replacement(path, init);
    return { ok: true, status: 200, json: async () => answer(path, init) };
  };
}

/**
 * Captures what saveBlob() would have downloaded. jsdom implements neither
 * URL.createObjectURL nor navigation, so the anchor's click is stood in for and
 * the Blob itself is what gets asserted.
 */
function captureDownload() {
  const saved = [];
  env.window.URL.createObjectURL = (blob) => { saved.push(blob); return 'blob:stub'; };
  env.window.URL.revokeObjectURL = () => {};
  globalThis.URL.createObjectURL = env.window.URL.createObjectURL;
  globalThis.URL.revokeObjectURL = env.window.URL.revokeObjectURL;
  const names = [];
  env.window.HTMLAnchorElement.prototype.click = function stubbedClick() {
    names.push(this.getAttribute('download'));
  };
  return { blobs: saved, names };
}

/** Drives a hidden file input the way picking a file does. */
function pickFile(inputId, file) {
  const input = doc.getElementById(inputId);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  change(input);
}

const jsonFile = (text, name = 'config.json') =>
  new env.window.File([text], name, { type: 'application/json' });

// ---------- boot ----------

describe('boot', () => {
  test('reads every panel it shows and renders both tables', async () => {
    await boot();

    assert.deepEqual(paths(), [
      '/api/notifications', '/api/relays', '/api/settings', '/api/config/key', '/api/config/security'
    ]);
    assert.match(text('#channel-table'), /No notification channels yet/);
    assert.match(text('#relay-table'), /No relays yet/);
  });

  test('the empty states name what each table is for', async () => {
    await boot();

    assert.match(text('#channel-table .empty'), /Add a webhook, Discord, ntfy, email, or Apprise channel/);
    assert.match(text('#relay-table .empty'),
      /only if you need to wake machines on a network Flatline is not attached to/);
  });

  test('both forms open in add mode', async () => {
    await boot();

    assert.equal(text('#channel-form-title'), 'Add notification channel');
    assert.equal(text('#channel-submit'), 'Add channel');
    assert.equal(text('#relay-form-title'), 'Add relay');
    assert.equal(text('#relay-submit'), 'Add relay');
  });
});

// ---------- sub-tabs ----------

describe('the sub-tabs', () => {
  const panel = (name) => doc.querySelector(`[data-panel="${name}"]`);
  const tab = (name) => doc.querySelector(`[role="tab"][data-tab="${name}"]`);

  test('General is the tab a first visit lands on', async () => {
    await boot();

    assert.equal(panel('general').hidden, false);
    assert.equal(panel('notifications').hidden, true);
    assert.equal(panel('relays').hidden, true);
    assert.equal(tab('general').getAttribute('aria-selected'), 'true');
  });

  test('picking one shows its panel and is remembered', async () => {
    await boot();

    click(tab('relays'));
    assert.equal(panel('relays').hidden, false);
    assert.equal(panel('general').hidden, true);
    assert.equal(env.window.localStorage.getItem('flatline:tab:config'), 'relays');
  });

  test('the remembered tab is the one that comes back', async () => {
    await boot({ storage: { 'flatline:tab:config': 'notifications' } });
    assert.equal(panel('notifications').hidden, false);
  });

  test('a URL hash beats the remembered choice, so a tab is linkable', async () => {
    await boot({
      url: 'http://localhost/config#relays',
      storage: { 'flatline:tab:config': 'notifications' }
    });
    assert.equal(panel('relays').hidden, false);
  });

  test('an unknown hash falls back to the first tab rather than hiding everything', async () => {
    await boot({ url: 'http://localhost/config#bogus' });
    assert.equal(panel('general').hidden, false);
  });

  test('a hidden panel keeps its markup, so the ids the page bound to still resolve', async () => {
    await boot({ channels: [channel()] });

    assert.equal(panel('notifications').hidden, true, 'not the open tab');
    assert.equal(rows('channel-table')[0][1], 'Phone', 'and yet it rendered');
  });

  test('the {url} hint on Notifications jumps to the setting that fills it', async () => {
    await boot({ storage: { 'flatline:tab:config': 'notifications' } });

    click(doc.getElementById('baseurl-jump'));
    assert.equal(panel('general').hidden, false);
  });
});

// ---------- the channel table ----------

describe('the channel table', () => {
  test('a row carries the status, name, service, events, credentials and last activity', async () => {
    await boot({
      channels: [channel({
        secret_fields: ['token'],
        config: { events: ['endpoint_down', 'run_failed'] },
        last_result: { ok: true, ts: 1_700_000_000_000, trigger: 'test', message: 'delivered' }
      })]
    });

    const row = rows('channel-table')[0];
    assert.equal(row[0], 'OK');
    assert.equal(row[1], 'Phone');
    assert.equal(row[2], 'ntfy');
    assert.equal(row[3], 'Endpoint DOWN, Action group run FAILED (or cancelled, or cut short by a restart)');
    assert.equal(row[4], '🔒 token');
    assert.match(row[5], /\(test\)$/);
  });

  describe('the status pill', () => {
    const pill = () => doc.querySelector('#channel-table .pill');

    test('a paused channel', async () => {
      await boot({ channels: [channel({ enabled: 0 })] });
      assert.equal(pill().textContent, 'DISABLED');
    });

    test('never used reads ENABLED, and says why there is nothing more to show', async () => {
      await boot({ channels: [channel()] });
      assert.equal(pill().textContent, 'ENABLED');
      assert.equal(pill().getAttribute('title'), 'Enabled — no test or delivery attempt yet');
    });

    test('a failed delivery carries the reason', async () => {
      await boot({
        channels: [channel({
          last_result: { ok: false, ts: 1_700_000_000_000, trigger: 'event', message: '502 from ntfy.sh' }
        })]
      });
      assert.equal(pill().textContent, 'FAILED');
      assert.match(pill().getAttribute('title'), /502 from ntfy\.sh/);
    });
  });

  test('a channel wired to nothing says so rather than showing a blank cell', async () => {
    await boot({ channels: [channel({ config: { events: [] } })] });
    assert.equal(rows('channel-table')[0][3], 'no events selected');
  });

  test('an unrecognised event key is shown as-is rather than dropped', async () => {
    await boot({ channels: [channel({ config: { events: ['something_new'] } })] });
    assert.equal(rows('channel-table')[0][3], 'something_new');
  });

  test('a real delivery is labelled as one, not as a test', async () => {
    await boot({
      channels: [channel({ last_result: { ok: true, ts: 1_700_000_000_000, trigger: 'event', message: 'ok' } })]
    });
    assert.match(rows('channel-table')[0][5], /\(delivery\)$/);
  });

  test('the row\'s Test button sends one and reports the outcome', async () => {
    await boot({ channels: [channel({ id: 3 })] });
    overrideFetch(
      (path, init) => path === '/api/notifications/test' && init?.method === 'POST',
      async () => ({ ok: true, status: 200, json: async () => ({ ok: true, message: 'delivered' }) })
    );

    click(rowButton('channel-table', 'Test'));
    await settle();

    assert.deepEqual(sent('POST'), { id: 3, kind: 'ntfy', config: data.channels[0].config, secrets: {} });
    assert.match(doc.querySelector('.modal-overlay').textContent, /Test delivered/);

    click(dialogButtons().confirm);
    await settle();
    assert.ok(paths().includes('/api/notifications'), 'and the list is re-read afterwards');
  });

  test('a rejected test is reported rather than swallowed', async () => {
    await boot({ channels: [channel()] });
    overrideFetch(
      (path, init) => init?.method === 'POST',
      async () => ({ ok: false, status: 400, json: async () => ({ error: 'topic is required' }) })
    );

    click(rowButton('channel-table', 'Test'));
    await settle();
    assert.match(doc.querySelector('.modal-overlay').textContent, /Test failed/);
    assert.match(doc.querySelector('.modal-overlay').textContent, /topic is required/);
  });
});

// ---------- the channel form ----------

describe('the channel form', () => {
  const form = () => doc.getElementById('channel-form');
  const field = (name) => form().elements.namedItem(name);
  const section = (kind) => doc.querySelector(`.kind-section[data-kind="${kind}"]`);
  const eventBoxes = () => [...doc.querySelectorAll('#channel-event-checks input[data-event]')];

  test('only the chosen service\'s fields are shown', async () => {
    await boot();
    assert.equal(section('webhook').style.display, '', 'webhook is the first option');
    assert.equal(section('email').style.display, 'none');

    doc.getElementById('c-kind').value = 'email';
    change(doc.getElementById('c-kind'));

    assert.equal(section('email').style.display, '');
    assert.equal(section('webhook').style.display, 'none');
  });

  test('ntfy\'s credentials follow its sign-in scheme', async () => {
    await boot();
    doc.getElementById('c-kind').value = 'ntfy';
    change(doc.getElementById('c-kind'));

    const token = doc.querySelector('[data-ntfy-auth="token"]');
    const username = doc.querySelector('[data-ntfy-auth="basic"]');
    assert.equal(token.style.display, 'none', 'no auth by default');
    assert.equal(username.style.display, 'none');

    const scheme = doc.getElementById('ntfy-auth-scheme');
    scheme.value = 'token';
    change(scheme);
    assert.equal(token.style.display, '');
    assert.equal(username.style.display, 'none');

    scheme.value = 'basic';
    change(scheme);
    assert.equal(token.style.display, 'none');
    assert.equal(username.style.display, '');
  });

  test('a new channel starts on the events worth waking someone for', async () => {
    await boot();

    const ticked = eventBoxes().filter((b) => b.checked).map((b) => b.value);
    assert.deepEqual(ticked, [
      'endpoint_down', 'group_armed', 'group_disarmed', 'group_triggered', 'action_failed', 'run_failed'
    ]);
    assert.equal(eventBoxes().length, 10, 'and every event is offered');
  });

  test('editing fills the fields, ticks that channel\'s events and retitles the form', async () => {
    await boot({
      channels: [channel({
        name: 'Ops mail', kind: 'email', enabled: 0,
        config: {
          events: ['endpoint_up'], title_template: 'T', body_template: 'B',
          host: 'smtp.x', port: 465, secure: true, from: 'a@x', to: 'b@x', username: 'a'
        }
      })]
    });

    click(rowButton('channel-table', 'Edit'));

    assert.equal(text('#channel-form-title'), 'Edit channel: Ops mail');
    assert.equal(text('#channel-submit'), 'Save changes');
    assert.equal(field('name').value, 'Ops mail');
    assert.equal(doc.getElementById('c-kind').value, 'email');
    assert.equal(field('enabled').checked, false);
    assert.equal(field('email_host').value, 'smtp.x');
    assert.equal(field('email_port').value, '465');
    assert.equal(field('email_secure').checked, true);
    assert.equal(field('email_from').value, 'a@x');
    assert.equal(field('email_to').value, 'b@x');
    assert.equal(field('title_template').value, 'T');
    assert.deepEqual(eventBoxes().filter((b) => b.checked).map((b) => b.value), ['endpoint_up']);
    assert.equal(section('email').style.display, '', 'and the right section is revealed');
  });

  test('a channel that names no events edits to nothing ticked', async () => {
    await boot({ channels: [channel({ config: {} })] });
    click(rowButton('channel-table', 'Edit'));
    assert.deepEqual(eventBoxes().filter((b) => b.checked), []);
  });

  test('adding sends the events, templates and that service\'s own fields', async () => {
    await boot();

    field('name').value = 'Phone';
    doc.getElementById('c-kind').value = 'ntfy';
    change(doc.getElementById('c-kind'));
    field('ntfy_server_url').value = 'https://ntfy.sh';
    field('ntfy_topic').value = 'flatline';
    field('ntfy_priority').value = '4';
    field('ntfy_token').value = 'tk_secret';
    doc.getElementById('ntfy-auth-scheme').value = 'token';
    change(doc.getElementById('ntfy-auth-scheme'));
    for (const box of eventBoxes()) box.checked = box.value === 'endpoint_down';

    submit(form());
    await settle();

    assert.deepEqual(paths('POST'), ['/api/notifications']);
    const body = sent('POST');
    assert.equal(body.kind, 'ntfy');
    assert.deepEqual(body.config, {
      events: ['endpoint_down'], title_template: '', body_template: '',
      server_url: 'https://ntfy.sh', topic: 'flatline', priority: '4',
      auth_scheme: 'token', username: ''
    });
    assert.deepEqual(body.secrets, { token: 'tk_secret' }, 'only the credentials that were typed');
  });

  test('a blank credential is omitted, so the stored one is kept', async () => {
    await boot({ channels: [channel({ id: 5, secret_fields: ['token'] })] });
    click(rowButton('channel-table', 'Edit'));

    submit(form());
    await settle();
    assert.deepEqual(paths('PUT'), ['/api/notifications/5']);
    assert.deepEqual(sent('PUT').secrets, {}, 'nothing typed, so nothing replaces what is stored');
  });

  test('clearing a stored credential sends an explicit null', async () => {
    await boot({ channels: [channel({ id: 5, secret_fields: ['token'] })] });
    click(rowButton('channel-table', 'Edit'));

    const clear = [...doc.querySelectorAll('#channel-form .secret-state .link-btn')]
      .find((b) => b.textContent === 'clear');
    click(clear);
    assert.equal(clear.textContent, 'undo', 'and it can be taken back');

    submit(form());
    await settle();
    assert.deepEqual(sent('PUT').secrets, { token: null });
  });

  test('a rejected save is shown on the form', async () => {
    await boot();
    overrideFetch(
      (path, init) => init?.method === 'POST',
      async () => ({ ok: false, status: 400, json: async () => ({ error: 'name is required' }) })
    );

    submit(form());
    await settle();
    assert.equal(text('#channel-error'), 'name is required');
  });

  describe('the Send test button', () => {
    test('says what it is doing, then reports the outcome', async () => {
      await boot();
      overrideFetch(
        (path) => path === '/api/notifications/test',
        async () => ({ ok: true, status: 200, json: async () => ({ ok: true, message: 'sent to flatline' }) })
      );

      click(doc.getElementById('channel-test'));
      assert.equal(text('#channel-test-result'), 'Sending test notification…');

      await settle();
      assert.equal(text('#channel-test-result'), '✓ sent to flatline');
      assert.equal(doc.getElementById('channel-test-result').className, 'note');
    });

    test('a failure is marked as one', async () => {
      await boot();
      overrideFetch(
        (path) => path === '/api/notifications/test',
        async () => ({ ok: true, status: 200, json: async () => ({ ok: false, message: 'no topic' }) })
      );

      click(doc.getElementById('channel-test'));
      await settle();
      assert.equal(text('#channel-test-result'), '✕ no topic');
      assert.equal(doc.getElementById('channel-test-result').className, 'error');
    });

    test('while editing, the test names the channel it is testing', async () => {
      await boot({ channels: [channel({ id: 9 })] });
      click(rowButton('channel-table', 'Edit'));

      click(doc.getElementById('channel-test'));
      await settle();
      assert.equal(sent('POST').id, 9, 'so the server can fall back to its stored credentials');
    });
  });

  test('deleting warns that alerts stop, then deletes', async () => {
    await boot({ channels: [channel({ id: 5 })] });

    click(rowButton('channel-table', 'Delete'));
    await settle();
    assert.match(doc.querySelector('.modal-overlay').textContent,
      /"Phone" will be deleted and will stop receiving alerts/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('DELETE'), ['/api/notifications/5']);
  });
});

// ---------- retention ----------

describe('the retention setting', () => {
  test('loads the stored value', async () => {
    await boot({ settings: settings({ retention_days: 7 }) });
    assert.equal(doc.getElementById('settings-form').elements.namedItem('retention_days').value, '7');
  });

  test('saving sends it and says so, then clears the note on its own', async () => {
    await boot();
    const form = doc.getElementById('settings-form');
    form.elements.namedItem('retention_days').value = '3';

    submit(form);
    await settle();
    assert.deepEqual(paths('PUT'), ['/api/settings']);
    assert.deepEqual(sent('PUT'), { retention_days: 3 });
    assert.equal(text('#settings-note'), 'Saved ✓');

    mock.timers.tick(2500);
    assert.equal(text('#settings-note'), '', 'the note does not linger');
  });

  test('a rejected save is reported instead', async () => {
    await boot();
    overrideFetch(
      (path, init) => path === '/api/settings' && init?.method === 'PUT',
      async () => ({ ok: false, status: 400, json: async () => ({ error: 'retention_days out of range' }) })
    );

    submit(doc.getElementById('settings-form'));
    await settle();
    assert.equal(text('#settings-note'), 'retention_days out of range');
    assert.equal(doc.getElementById('settings-note').className, 'error');
  });
});

// ---------- the site URL ----------

describe('the site URL', () => {
  const input = () => doc.getElementById('baseurl-form').elements.namedItem('base_url');

  test('unset, it says notifications carry no link', async () => {
    await boot();
    assert.equal(input().value, '');
    assert.equal(text('#baseurl-status'), 'Not set — notifications carry no link.');
    assert.equal(input().disabled, false);
  });

  test('set, it says what the link points at', async () => {
    await boot({ settings: settings({ base_url: 'https://flatline.lan' }) });
    assert.equal(input().value, 'https://flatline.lan');
    assert.equal(text('#baseurl-status'), 'Notifications link back to this address.');
  });

  test('set by the environment, the field is shown but locked', async () => {
    await boot({ settings: settings({ base_url: 'https://env.lan', base_url_source: 'env' }) });

    assert.equal(input().value, 'https://env.lan', 'shown, so it can be found');
    assert.equal(input().disabled, true);
    assert.equal(doc.getElementById('baseurl-save').disabled, true);
    assert.match(text('#baseurl-status'), /FLATLINE_BASE_URL environment variable — unset it to edit here/);
  });

  test('saving sends it and re-applies whatever the server settled on', async () => {
    await boot();
    input().value = 'https://flatline.lan';

    submit(doc.getElementById('baseurl-form'));
    await settle();
    assert.deepEqual(sent('PUT'), { base_url: 'https://flatline.lan' });
    assert.equal(text('#baseurl-note'), 'Saved ✓');
  });
});

// ---------- the encryption key ----------

describe('the encryption key', () => {
  test('a key file offers rotation, and counts what is encrypted under it', async () => {
    await boot({ key: keyStatus({ source: 'file', encrypted_items: 4 }) });

    assert.match(text('#key-status'), /auto-generated key file in the data directory — 4 encrypted item\(s\) stored/);
    assert.equal(doc.getElementById('key-rotate-section').style.display, '');
  });

  test('an environment key hides rotation and says how to change it', async () => {
    await boot({ key: keyStatus({ source: 'env' }) });

    assert.match(text('#key-status'), /FLATLINE_SECRET_KEY environment variable/);
    assert.match(text('#key-status'), /update the environment variable to the same value before the next restart/);
    assert.equal(doc.getElementById('key-rotate-section').style.display, 'none');
  });

  test('Generate fills the field with 32 bytes of hex and warns to copy it', async () => {
    await boot();

    click(doc.getElementById('key-generate'));
    const key = doc.getElementById('key-form').elements.namedItem('key').value;
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.match(text('#key-note'), /copy it somewhere safe before saving/);
    assert.equal(text('#key-dirty'), 'Unsaved changes');
  });

  test('rotating warns the old key stops working, then rotates and re-reads the status', async () => {
    await boot();

    click(doc.getElementById('key-rotate'));
    await settle();
    const dialog = doc.querySelector('.modal-overlay');
    assert.match(dialog.textContent, /every stored credential re-encrypted under it/);
    assert.match(dialog.textContent, /without it, stored credentials CANNOT be recovered/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('POST'), ['/api/config/key/rotate']);
    assert.match(text('#key-note'), /^✓/);
    assert.equal(paths().filter((p) => p === '/api/config/key').length, 2);
  });

  test('backing out of a rotation changes nothing', async () => {
    await boot();
    click(doc.getElementById('key-rotate'));
    await settle();
    click(dialogButtons().cancel);
    await settle();

    assert.deepEqual(paths('POST'), []);
    assert.equal(doc.getElementById('key-rotate').disabled, false);
  });

  test('submitting an empty key is refused before anything is sent', async () => {
    await boot();

    submit(doc.getElementById('key-form'));
    await settle();
    assert.equal(text('#key-error'), 'enter or generate a key first');
    assert.equal(doc.querySelector('.modal-overlay'), null, 'not even the confirmation');
  });

  test('re-encrypting confirms first, then sends the key and clears the field', async () => {
    await boot();
    const form = doc.getElementById('key-form');
    form.elements.namedItem('key').value = 'ab'.repeat(32);

    submit(form);
    await settle();
    assert.match(doc.querySelector('.modal-overlay').textContent, /Re-encrypt with this key\?/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('PUT'), ['/api/config/key']);
    assert.deepEqual(sent('PUT'), { key: 'ab'.repeat(32) });
    assert.equal(form.elements.namedItem('key').value, '', 'the key is not left on screen');
    assert.equal(text('#key-dirty'), '');
  });

  test('a rejected key is reported and the field left alone', async () => {
    await boot();
    const form = doc.getElementById('key-form');
    form.elements.namedItem('key').value = 'too-short';
    overrideFetch(
      (path, init) => path === '/api/config/key' && init?.method === 'PUT',
      async () => ({ ok: false, status: 400, json: async () => ({ error: 'key must be 64 hex characters' }) })
    );

    submit(form);
    await settle();
    click(dialogButtons().confirm);
    await settle();

    assert.equal(text('#key-error'), 'key must be 64 hex characters');
    assert.equal(form.elements.namedItem('key').value, 'too-short', 'so it can be corrected');
  });
});

// ---------- site access ----------

describe('site access', () => {
  test('with no password, it spells out that the instance is open', async () => {
    await boot();

    assert.match(text('#auth-status'), /No password set — anyone who can reach this port has full control/);
    assert.equal(text('#password-cap'), 'Set a site password (min 8 chars)');
    assert.equal(text('#password-set'), 'Set password');
    assert.equal(doc.getElementById('password-remove').style.display, 'none');
  });

  test('with one set, it offers a change and a removal', async () => {
    await boot({ securityConfig: security({ password_source: 'settings' }) });

    assert.match(text('#auth-status'), /a site password is set. Sessions last 7 days/);
    assert.equal(text('#password-cap'), 'Change the site password (min 8 chars)');
    assert.equal(text('#password-set'), 'Change password');
    assert.equal(doc.getElementById('password-remove').style.display, '');
  });

  test('an environment password locks the form rather than pretending it can be changed', async () => {
    await boot({ securityConfig: security({ password_source: 'env' }) });

    assert.match(text('#auth-status'), /FLATLINE_PASSWORD environment variable and can only be changed there/);
    const form = doc.getElementById('password-form');
    assert.equal(form.elements.namedItem('password').disabled, true);
    assert.equal(doc.getElementById('password-set').disabled, true);
    assert.equal(doc.getElementById('password-remove').style.display, 'none');
  });

  test('mismatched passwords are caught before anything is sent', async () => {
    await boot();
    const form = doc.getElementById('password-form');
    form.elements.namedItem('password').value = 'hunter22';
    form.elements.namedItem('password2').value = 'hunter23';

    submit(form);
    await settle();
    assert.equal(text('#password-error'), 'passwords do not match');
    assert.deepEqual(paths('PUT'), []);
    assert.equal(doc.querySelector('.modal-overlay'), null);
  });

  test('saving one warns that other sessions are signed out, then sends it', async () => {
    await boot();
    const form = doc.getElementById('password-form');
    form.elements.namedItem('password').value = 'hunter22';
    form.elements.namedItem('password2').value = 'hunter22';

    submit(form);
    await settle();
    assert.match(doc.querySelector('.modal-overlay').textContent, /Any other active sessions will be signed out/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('PUT'), ['/api/config/password']);
    assert.deepEqual(sent('PUT'), { password: 'hunter22' });
    assert.equal(form.elements.namedItem('password').value, '', 'and it is not left on screen');
  });

  test('removing one warns the instance becomes open, then removes it', async () => {
    await boot({ securityConfig: security({ password_source: 'settings' }) });

    click(doc.getElementById('password-remove'));
    await settle();
    assert.match(doc.querySelector('.modal-overlay').textContent,
      /will be open to anyone who can reach this URL or IP:Port/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('DELETE'), ['/api/config/password']);
  });

  test('allowed hosts load, and save', async () => {
    await boot({ securityConfig: security({ allowed_hosts: 'flatline.lan, 10.0.0.5' }) });
    const form = doc.getElementById('hosts-form');
    assert.equal(form.elements.namedItem('allowed_hosts').value, 'flatline.lan, 10.0.0.5');

    form.elements.namedItem('allowed_hosts').value = 'flatline.lan';
    submit(form);
    await settle();
    assert.deepEqual(sent('PUT'), { allowed_hosts: 'flatline.lan' });
    assert.equal(text('#hosts-note'), 'Saved ✓');
  });

  test('allowed hosts from the environment are locked and say where to change them', async () => {
    await boot({ securityConfig: security({ allowed_hosts: 'a.lan', allowed_hosts_source: 'env' }) });

    assert.equal(doc.getElementById('hosts-form').elements.namedItem('allowed_hosts').disabled, true);
    assert.equal(doc.getElementById('hosts-save').disabled, true);
    assert.equal(text('#hosts-note'), 'Set via FLATLINE_ALLOWED_HOSTS — change it there.');
  });
});

// ---------- relays ----------

describe('the relay table', () => {
  test('a row carries the switch, name, type, connection, network, command and credentials', async () => {
    await boot({ relays: [relay({ secret_fields: ['password'] })] });

    assert.deepEqual(rows('relay-table')[0].slice(0, 7),
      ['ENABLED', 'VLAN20', 'SSH', 'root@10.1.20.10:22', '10.1.20.0/24', 'wakeonlan {mac}', '🔒 password']);
  });

  test('a WinRM relay puts the domain in front of the user', async () => {
    await boot({
      relays: [relay({
        kind: 'winrm',
        config: { host: '10.1.20.11', port: 5985, domain: 'CORP', username: 'svc' }
      })]
    });
    assert.equal(rows('relay-table')[0][3], 'CORP\\svc@10.1.20.11:5985');
  });

  test('a relay with no credentials shows a dash', async () => {
    await boot({ relays: [relay()] });
    assert.equal(rows('relay-table')[0][6], '—');
  });

  test('deleting warns which targets stop waking, then deletes', async () => {
    await boot({ relays: [relay({ id: 2 })] });

    click(rowButton('relay-table', 'Delete'));
    await settle();
    assert.match(doc.querySelector('.modal-overlay').textContent,
      /Any action target set to wake through this relay will stop waking/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('DELETE'), ['/api/relays/2']);
  });
});

describe('the relay form', () => {
  const form = () => doc.getElementById('relay-form');
  const field = (name) => form().elements.namedItem(name);
  const kind = () => doc.getElementById('r-kind');

  test('only the chosen type\'s connection fields are shown', async () => {
    await boot();
    assert.equal(doc.querySelector('[data-relay-kind="ssh"]').style.display, '');
    assert.equal(doc.querySelector('[data-relay-kind="winrm"]').style.display, 'none');

    kind().value = 'winrm';
    change(kind());
    assert.equal(doc.querySelector('[data-relay-kind="winrm"]').style.display, '');
    assert.equal(doc.querySelector('[data-relay-kind="ssh"]').style.display, 'none');
  });

  test('SSH\'s credentials follow its auth method', async () => {
    await boot();
    const password = doc.querySelector('[data-relay-ssh-auth="password"]');
    const key = doc.querySelector('[data-relay-ssh-auth="key"]');
    assert.equal(password.style.display, '');
    assert.equal(key.style.display, 'none');

    field('ssh_auth_method').value = 'key';
    change(field('ssh_auth_method'));
    assert.equal(password.style.display, 'none');
    assert.equal(key.style.display, '');
  });

  test('switching type follows with that type\'s default wake command', async () => {
    await boot();
    assert.equal(field('wake_command').value, 'wakeonlan {mac}');

    kind().value = 'winrm';
    change(kind());
    assert.match(field('wake_command').value, /UdpClient/, 'the PowerShell one-liner');

    kind().value = 'ssh';
    change(kind());
    assert.equal(field('wake_command').value, 'wakeonlan {mac}');
  });

  test('a command someone typed themselves is never overwritten', async () => {
    await boot();
    field('wake_command').value = 'etherwake -i eth1 {mac}';

    kind().value = 'winrm';
    change(kind());
    assert.equal(field('wake_command').value, 'etherwake -i eth1 {mac}');
  });

  test('the reset link puts the default back', async () => {
    await boot();
    field('wake_command').value = 'etherwake {mac}';

    click(doc.getElementById('relay-cmd-reset'));
    assert.equal(field('wake_command').value, 'wakeonlan {mac}');
    assert.equal(text('#relay-dirty'), 'Unsaved changes');
  });

  test('editing fills the fields and retitles the form', async () => {
    await boot({ relays: [relay({ id: 2, network: '10.9.0.0/16', wake_command: 'wol {mac}' })] });

    click(rowButton('relay-table', 'Edit'));

    assert.equal(text('#relay-form-title'), 'Edit relay: VLAN20');
    assert.equal(field('name').value, 'VLAN20');
    assert.equal(kind().value, 'ssh');
    assert.equal(field('ssh_host').value, '10.1.20.10');
    assert.equal(field('ssh_port').value, '22');
    assert.equal(field('ssh_username').value, 'root');
    assert.equal(field('network').value, '10.9.0.0/16');
    assert.equal(field('wake_command').value, 'wol {mac}');
  });

  test('adding sends the connection, network and command', async () => {
    await boot();

    field('name').value = 'VLAN20';
    field('ssh_host').value = '10.1.20.10';
    field('ssh_username').value = 'root';
    field('network').value = '10.1.20.0/24';
    field('ssh_password').value = 'pw';

    submit(form());
    await settle();

    assert.deepEqual(paths('POST'), ['/api/relays']);
    assert.deepEqual(sent('POST'), {
      name: 'VLAN20', kind: 'ssh',
      config: { host: '10.1.20.10', port: 22, username: 'root', auth_method: 'password' },
      wake_command: 'wakeonlan {mac}', network: '10.1.20.0/24',
      secrets: { password: 'pw' }, enabled: true
    });
  });

  test('the Test button reports whether the relay answered', async () => {
    await boot({ relays: [relay({ id: 2 })] });
    overrideFetch(
      (path) => path === '/api/relays/test',
      async () => ({ ok: true, status: 200, json: async () => ({ ok: false, message: 'auth failed' }) })
    );

    click(doc.getElementById('relay-test'));
    assert.equal(text('#relay-test-result'), 'Testing…');

    await settle();
    assert.equal(text('#relay-test-result'), '✕ auth failed');
    assert.equal(doc.getElementById('relay-test-result').className, 'error');
  });
});

// ---------- backup & restore ----------

describe('config transfer', () => {
  test('exporting downloads the config as dated JSON', async () => {
    await boot();
    const download = captureDownload();
    overrideFetch(
      (path) => path === '/api/config/export',
      async () => ({ ok: true, status: 200, json: async () => ({ endpoints: [{ id: 1 }] }) })
    );

    click(doc.getElementById('config-export'));
    await settle();

    assert.equal(download.blobs.length, 1);
    assert.equal(await download.blobs[0].text(), JSON.stringify({ endpoints: [{ id: 1 }] }, null, 2));
    assert.match(download.names[0], /^flatline-config-\d{8}-\d{6}\.json$/);
    assert.equal(text('#config-transfer-note'), 'Exported ✓');
  });

  test('a failed export is reported and the note cleared', async () => {
    await boot();
    captureDownload();
    overrideFetch(
      (path) => path === '/api/config/export',
      async () => ({ ok: false, status: 500, json: async () => ({ error: 'export failed' }) })
    );

    click(doc.getElementById('config-export'));
    await settle();
    assert.equal(text('#config-transfer-note'), '');
    assert.equal(text('#config-transfer-error'), 'export failed');
  });

  test('a file that is not JSON is refused before the confirmation', async () => {
    await boot();

    pickFile('config-import', jsonFile('not json at all'));
    await settle();

    assert.equal(text('#config-transfer-error'), 'that file is not valid JSON');
    assert.equal(doc.querySelector('.modal-overlay'), null);
    assert.deepEqual(paths('POST'), []);
  });

  test('importing warns what it replaces, then imports and re-reads every panel', async () => {
    await boot();

    pickFile('config-import', jsonFile('{"endpoints":[]}'));
    await settle();
    const dialog = doc.querySelector('.modal-overlay');
    assert.match(dialog.textContent, /REPLACES all current endpoints/);
    assert.match(dialog.textContent, /only work if this instance uses the same encryption key/);

    click(dialogButtons().confirm);
    await settle();

    assert.deepEqual(paths('POST'), ['/api/config/import']);
    assert.deepEqual(sent('POST'), { endpoints: [] });
    assert.equal(text('#config-transfer-note'), 'Configuration imported ✓');
    for (const path of ['/api/notifications', '/api/settings', '/api/config/key', '/api/config/security']) {
      assert.ok(paths().filter((p) => p === path).length >= 2, `${path} was read again`);
    }
  });

  test('backing out of an import sends nothing', async () => {
    await boot();

    pickFile('config-import', jsonFile('{"endpoints":[]}'));
    await settle();
    click(dialogButtons().cancel);
    await settle();
    assert.deepEqual(paths('POST'), []);
  });
});

describe('database backup and reset', () => {
  test('backing up downloads the database file', async () => {
    await boot();
    const download = captureDownload();
    overrideFetch(
      (path) => path === '/api/config/backup',
      async () => ({ ok: true, status: 200, blob: async () => new env.window.Blob(['sqlite']) })
    );

    click(doc.getElementById('db-backup'));
    await settle();

    assert.equal(download.blobs.length, 1);
    assert.match(download.names[0], /^flatline-backup-\d{8}-\d{6}\.db$/);
    assert.equal(text('#db-transfer-note'), 'Backup downloaded ✓');
  });

  test('restoring warns it overwrites everything, then uploads the file', async () => {
    await boot();
    const file = new env.window.File(['sqlite'], 'backup.db');

    pickFile('db-restore', file);
    await settle();
    const dialog = doc.querySelector('.modal-overlay');
    assert.match(dialog.textContent, /OVERWRITES the entire database/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('POST'), ['/api/config/restore']);
    assert.equal(sent('POST'), file, 'the file goes up as-is, not as JSON');
    assert.equal(text('#db-transfer-note'), 'Database restored ✓');
    assert.ok(paths().filter((p) => p === '/api/relays').length >= 2, 'and the relays are re-read');
  });

  test('resetting spells out everything it deletes, including the login', async () => {
    await boot();

    click(doc.getElementById('app-reset'));
    await settle();
    const dialog = doc.querySelector('.modal-overlay');
    assert.match(dialog.textContent, /PERMANENTLY deletes ALL endpoints/);
    assert.match(dialog.textContent, /removes the site password \(login turns OFF/);
    assert.match(dialog.textContent, /The encryption key is kept/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('POST'), ['/api/config/reset']);
    assert.equal(text('#db-transfer-note'), 'Flatline reset to a clean start ✓');
  });

  test('backing out of a reset sends nothing', async () => {
    await boot();
    click(doc.getElementById('app-reset'));
    await settle();
    click(dialogButtons().cancel);
    await settle();
    assert.deepEqual(paths('POST'), []);
  });
});

// ---------- polling ----------

describe('polling', () => {
  test('re-reads the channels every twenty seconds, and nothing else', async () => {
    await boot();
    const before = paths().length;

    mock.timers.tick(19_999);
    await settle();
    assert.equal(paths().length, before);

    mock.timers.tick(1);
    await settle();
    assert.deepEqual(paths().slice(before), ['/api/notifications'],
      'the key, security and settings panels are not re-read behind the operator');
  });

  test('a delivery result landing between polls reaches the table', async () => {
    await boot({ channels: [channel()] });
    assert.equal(rows('channel-table')[0][0], 'ENABLED');

    data.channels = [channel({ last_result: { ok: false, ts: 1_700_000_000_000, trigger: 'event', message: 'refused' } })];
    mock.timers.tick(20_000);
    await settle();

    assert.equal(rows('channel-table')[0][0], 'FAILED');
  });
});

// ---------- the session snapshot ----------

describe('the session snapshot', () => {
  const KEY = 'flatline.snap.config';
  const snapshot = (payload, ts = Date.now()) => JSON.stringify({ ts, data: payload });
  const held = { channels: [channel()], relays: [relay()] };

  test('last session\'s two tables are painted before the live lists arrive', async () => {
    env = setupDom(HTML, 'http://localhost/config');
    doc = env.document;
    env.window.sessionStorage.setItem(KEY, snapshot(held));
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    calls = [];
    globalThis.fetch = () => new Promise(() => {});

    await importFresh(CONFIG);
    await settle();

    assert.equal(rows('channel-table')[0][1], 'Phone');
    assert.equal(rows('relay-table')[0][1], 'VLAN20');
  });

  test('the panels describing how this instance is secured are never drawn from it', async () => {
    env = setupDom(HTML, 'http://localhost/config');
    doc = env.document;
    env.window.sessionStorage.setItem(KEY, snapshot(held));
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    calls = [];
    globalThis.fetch = () => new Promise(() => {});

    await importFresh(CONFIG);
    await settle();

    assert.equal(text('#key-status'), 'Loading key status…');
    assert.equal(text('#auth-status'), 'Loading…');
    assert.equal(text('#baseurl-status'), 'Loading…',
      'a stale answer here would be worse than a blank field for a moment');
  });

  test('leaving the page saves both tables', async () => {
    await boot({ channels: [channel()], relays: [relay()] });

    env.window.dispatchEvent(new env.window.Event('pagehide'));

    const saved = JSON.parse(env.window.sessionStorage.getItem(KEY));
    assert.deepEqual(Object.keys(saved.data).sort(), ['channels', 'relays']);
    assert.deepEqual(saved.data.channels.map((c) => c.name), ['Phone']);
    assert.deepEqual(saved.data.relays.map((r) => r.name), ['VLAN20']);
  });

  test('nothing is saved until both lists have arrived', async () => {
    env = setupDom(HTML, 'http://localhost/config');
    doc = env.document;
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    calls = [];
    // Only the channels answer; the relays never do, so the page is half loaded.
    globalThis.fetch = async (path) => (path === '/api/relays'
      ? new Promise(() => {})
      : { ok: true, status: 200, json: async () => (BODIES[path] ? BODIES[path]() : []) });
    data = { channels: [channel()], relays: [], settings: settings(), key: keyStatus(), security: security() };

    await importFresh(CONFIG);
    await settle();

    env.window.dispatchEvent(new env.window.Event('pagehide'));
    assert.equal(env.window.sessionStorage.getItem(KEY), null);
  });
});
