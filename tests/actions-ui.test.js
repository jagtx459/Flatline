import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDom, importFresh, click, flush } from './helpers/jsdom-env.js';

/**
 * public/scripts/actions.js — the Actions page: the action target table and its
 * form (four kinds of connection, plus the Restore panel that serves all of
 * them), and the action group table with its stage editor.
 *
 * Same harness as the other two page suites — the real public/actions.html is
 * loaded into jsdom and the import is what boots the page — with three things
 * this page adds:
 *
 *  - Mock timers. It sweeps every 20 seconds, and polls a running restore every
 *    3, so a test process would never exit without them; they also make the
 *    restore's phase line something that can be driven rather than waited for.
 *  - An EventSource that records its listener, so the /api/stream "something
 *    changed" nudge can be fired by hand. jsdom implements no EventSource, and
 *    the one in jsdom-env.js only exists to let a module load.
 *  - The Restore panel is the reason most of this file exists. It is one panel
 *    serving four target kinds across two independently-configured steps, shown
 *    on two axes at once (the step's method, and that method's own sign-in), and
 *    it is the part of the page that is easiest to break silently.
 *
 * The site header comes with the page, so every boot also fetches /api/version
 * and /api/auth; `paths()` drops those.
 */

const ACTIONS = new URL('../public/scripts/actions.js', import.meta.url).href;
const HTML = readFileSync(new URL('../public/actions.html', import.meta.url), 'utf8');

const NOW = 1_700_000_000_000;

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;

let env;
let doc;
let data;
let calls;
let stream;

// ---------- fixtures (shapes mirror the /api/actions/* routes in server/index.js) ----------

function target(over = {}) {
  return {
    id: 1, name: 'nas', kind: 'ssh', enabled: 1,
    config: { host: '10.1.20.50', port: 22, username: 'root', command: 'shutdown -h now' },
    secret_fields: [], health: null, last_activity: null, restore_progress: null,
    ...over
  };
}

function igroup(over = {}) {
  return {
    id: 1, name: 'Shutdown', enabled: 1, on_failure: 'continue', stop_on_restore: 0,
    stages: [], assigned_count: 0,
    ...over
  };
}

const stage = (over = {}) => ({ pass_rule: 'any', on_failure: null, wait_seconds: 5, steps: [], ...over });

const flatlineGroup = (over = {}) => ({
  id: 1, name: 'Rack', mode: 'all', grace_minutes: 5, enabled: 1,
  endpoint_ids: [], action_group_ids: [], ...over
});

const relay = (over = {}) => ({
  id: 1, name: 'VLAN20', kind: 'ssh', enabled: 1, network: '10.1.20.0/24', ...over
});

// ---------- harness ----------

async function boot({
  targets = [], igroups = [], flatlineGroups = [], relays = [], groupStates = [], storage, session
} = {}) {
  env = setupDom(HTML, 'http://localhost/actions');
  doc = env.document;
  for (const [k, v] of Object.entries(storage ?? {})) env.window.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(session ?? {})) env.window.sessionStorage.setItem(k, v);

  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  installStream();

  // The banners every page carries read this; nothing armed unless a test says so.
  data = { targets, igroups, flatlineGroups, relays, groupStates };
  calls = [];
  globalThis.fetch = defaultFetch;

  await importFresh(ACTIONS);
  await settle();
  return doc;
}

/** An EventSource that keeps hold of its 'change' listener, so a test can fire
 *  the nudge the server sends when something on this page moved. */
function installStream() {
  stream = {
    url: null, opened: 0, closed: 0, listeners: [],
    fire() { for (const fn of this.listeners) fn(); }
  };
  globalThis.EventSource = class {
    constructor(url) { stream.url = url; stream.opened += 1; }
    addEventListener(type, fn) { if (type === 'change') stream.listeners.push(fn); }
    close() { stream.closed += 1; }
  };
}

const BODIES = {
  '/api/version': () => ({ version: '1.0.0' }),
  '/api/auth': () => ({ auth_required: false }),
  '/api/actions/targets': () => data.targets,
  '/api/actions/groups': () => data.igroups,
  '/api/groups': () => data.flatlineGroups,
  '/api/groups/states': () => ({ now: Date.now(), groups: data.groupStates }),
  '/api/relays': () => data.relays
};

/**
 * The list routes answer reads; a write answers with the row it saved, carrying
 * the id from its own URL. That id matters — initEntityForm hands it straight to
 * the Flatline-group assignment, which is written separately.
 */
function answer(path, init) {
  const method = init?.method ?? 'GET';
  if (method === 'GET' && BODIES[path]) return BODIES[path]();
  const id = Number(path.match(/\/(\d+)$/)?.[1]) || 1;
  return { id, name: 'saved', ok: true, message: 'done' };
}

async function defaultFetch(path, init) {
  calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, json: async () => answer(path, init) };
}

/** Answers one request differently, leaving every other one alone. */
function overrideFetch(match, replacement) {
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    if (match(path, init)) return replacement(path, init);
    return { ok: true, status: 200, json: async () => answer(path, init) };
  };
}

const settle = () => flush(6);

afterEach(() => {
  mock.timers.reset();
  env.cleanup();
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});

/** The requests this page made, less the ones every page makes: the header's
 *  two and the banners' group states. */
const paths = (method = 'GET') => calls
  .filter((c) => c.method === method && !SHARED_PATHS.has(c.path))
  .map((c) => c.path);

const SHARED_PATHS = new Set(['/api/version', '/api/auth', '/api/groups/states']);

const sent = (method) => calls.find((c) => c.method === method)?.body;
const allSent = (method) => calls.filter((c) => c.method === method).map((c) => c.body);

const submit = (form) =>
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));

const change = (node) => node.dispatchEvent(new env.window.Event('change', { bubbles: true }));
const input = (node) => node.dispatchEvent(new env.window.Event('input', { bubbles: true }));

const text = (sel, root = doc) => root.querySelector(sel)?.textContent ?? null;

const rows = (id) => [...doc.querySelectorAll(`#${id} tbody tr`)]
  .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

function dialogButtons() {
  const buttons = [...doc.querySelectorAll('.modal-overlay .modal-actions button')];
  return buttons.length > 1 ? { cancel: buttons[0], confirm: buttons[1] } : { cancel: null, confirm: buttons[0] };
}

const rowButton = (tableId, label) =>
  [...doc.querySelectorAll(`#${tableId} tbody button`)].find((b) => b.textContent === label);

const tForm = () => doc.getElementById('target-form');
const tField = (name) => tForm().elements.namedItem(name);
const shown = (node) => node.style.display !== 'none';

/** Puts the target form on a kind, as choosing it from the select does. */
function chooseKind(kind) {
  doc.getElementById('t-kind').value = kind;
  change(doc.getElementById('t-kind'));
}

/** Turns the Restore panel on and puts its two steps on the given methods. */
function configureRestore({ kind, post = 'none', inherit, postInherit } = {}) {
  tField('restore_enabled').checked = true;
  if (kind) tField('restore_kind').value = kind;
  tField('post_restore_kind').value = post;
  if (inherit != null) tField('restore_inherit').value = inherit;
  if (postInherit != null) tField('post_restore_inherit').value = postInherit;
  change(tField('restore_enabled'));
}

// ---------- boot ----------

describe('boot', () => {
  test('reads the four lists it needs and renders both tables', async () => {
    await boot();

    assert.deepEqual(paths(), ['/api/actions/targets', '/api/actions/groups', '/api/groups', '/api/relays']);
    assert.match(text('#target-table'), /No action targets yet/);
    assert.match(text('#igroup-table'), /No action groups yet/);
  });

  test('both forms open in add mode', async () => {
    await boot();

    assert.equal(text('#target-form-title'), 'Add action target');
    assert.equal(text('#target-submit'), 'Add target');
    assert.equal(text('#igroup-form-title'), 'Add action group');
  });

  test('it subscribes to the change stream', async () => {
    await boot();
    // health=1: this page shows the targets' connectivity dots, which is what
    // puts the server's target poller on its fast cadence. One connection, not
    // two — the banners own it and the target rows ride along.
    assert.equal(stream.url, '/api/stream?health=1');
    assert.equal(stream.listeners.length, 1);
  });

  // A browser allows only about six connections to one origin, and an open
  // stream holds one for as long as its page lives. A page in the back/forward
  // cache is not destroyed, so streams left open there stack up until nothing
  // can get a connection — not even the HTML of the page being navigated to.
  test('the stream is released when the page goes away', async () => {
    await boot();
    assert.equal(stream.closed, 0);

    env.window.dispatchEvent(new env.window.Event('pagehide'));
    assert.equal(stream.closed, 1);
  });

  test('coming back from the back/forward cache reconnects and refetches', async () => {
    await boot();
    env.window.dispatchEvent(new env.window.Event('pagehide'));
    const before = paths().length;

    const restored = new env.window.Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    env.window.dispatchEvent(restored);
    await settle();

    assert.equal(stream.opened, 2, 'a fresh connection, the closed one being no use');
    assert.ok(paths().length > before, 'and what it missed while the page was away');
  });

  test('an ordinary load is not mistaken for a cache restore', async () => {
    await boot();
    const opened = stream.opened;

    // persisted: false — the page was built from scratch, and already has a
    // stream from module load. Reopening here would leak one per navigation.
    env.window.dispatchEvent(new env.window.Event('pageshow'));
    await settle();

    assert.equal(stream.opened, opened);
  });
});

// ---------- the target table ----------

describe('the target table', () => {
  test('a row carries the status, name, type, connection, action, credentials and activity', async () => {
    await boot({
      targets: [target({
        secret_fields: ['password'],
        health: { ok: true, checkedAt: NOW - 30_000, message: 'connected' },
        last_activity: { ts: NOW - 60_000, trigger: 'run' }
      })]
    });

    const row = rows('target-table')[0];
    assert.equal(row[0], 'UP');
    assert.equal(row[1], 'nas');
    assert.equal(row[2], 'SSH');
    assert.equal(row[3], 'root@10.1.20.50:22');
    assert.equal(row[4], 'shutdown -h now');
    assert.equal(row[5], '🔒 password');
    assert.match(row[6], /\(run\)$/);
  });

  describe('the status dot', () => {
    const pill = () => doc.querySelector('#target-table .pill');

    test('a paused target is not health-checked, whatever it last said', async () => {
      await boot({ targets: [target({ enabled: 0, health: { ok: true, checkedAt: NOW, message: 'ok' } })] });
      assert.equal(pill().textContent, 'DISABLED');
    });

    test('never checked reads PENDING', async () => {
      await boot({ targets: [target()] });
      assert.equal(pill().textContent, 'PENDING');
    });

    test('a failed check carries when and why', async () => {
      await boot({
        targets: [target({ health: { ok: false, checkedAt: NOW, message: 'connection refused' } })]
      });
      assert.equal(pill().textContent, 'DOWN');
      assert.match(pill().getAttribute('title'), /connection refused/);
    });
  });

  describe('the connection and action columns', () => {
    const cells = () => rows('target-table')[0];

    test('WinRM puts the domain in front of the user', async () => {
      await boot({
        targets: [target({
          kind: 'winrm',
          config: { host: '10.1.20.51', port: 5985, domain: 'CORP', username: 'svc', command: 'stop-computer' }
        })]
      });
      assert.equal(cells()[2], 'WinRM');
      assert.equal(cells()[3], 'CORP\\svc@10.1.20.51:5985');
      assert.equal(cells()[4], 'stop-computer');
    });

    test('a cluster set to drain says so in words', async () => {
      await boot({
        targets: [target({ kind: 'k8s', config: { api_url: 'https://10.0.0.10:6443', action: 'drain' } })]
      });
      assert.equal(cells()[2], 'Kubernetes');
      assert.equal(cells()[3], 'https://10.0.0.10:6443');
      assert.equal(cells()[4], 'drain all nodes');
    });

    test('a cluster set to a custom request shows the request', async () => {
      await boot({
        targets: [target({
          kind: 'k8s',
          config: { api_url: 'https://x:6443', action: 'custom', command_method: 'POST', command_path: '/apis/x' }
        })]
      });
      assert.equal(cells()[4], 'POST /apis/x');
    });

    test('an http target names the verb it will send', async () => {
      await boot({
        targets: [target({ kind: 'http', config: { url: 'https://host/api/shutdown', method: 'PUT' } })]
      });
      assert.equal(cells()[2], 'HTTP(S)');
      assert.equal(cells()[3], 'https://host/api/shutdown');
      assert.equal(cells()[4], 'send PUT request');
    });

    test('a target with no command shows a dash rather than an empty cell', async () => {
      await boot({ targets: [target({ config: { host: 'h', port: 22, username: 'u', command: '' } })] });
      assert.equal(cells()[4], '—');
    });

    test('a target with no stored credentials shows a dash', async () => {
      await boot({ targets: [target()] });
      assert.equal(cells()[5], '—');
    });

    test('a target never acted on reads never', async () => {
      await boot({ targets: [target()] });
      assert.equal(cells()[6], 'never');
    });
  });
});

// ---------- Run and Restore ----------

describe('the Run button', () => {
  test('warns the real command goes out now, then runs it', async () => {
    await boot({ targets: [target({ id: 3 })] });

    click(rowButton('target-table', 'Run'));
    await settle();
    const dialog = doc.querySelector('.modal-overlay');
    assert.match(dialog.textContent, /Run this action now\?/);
    assert.match(dialog.textContent, /runs the real command configured for "nas" immediately/);
    assert.match(dialog.textContent, /CANNOT be undone/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('POST'), ['/api/actions/targets/3/run']);
  });

  test('an http target is warned about as a request, not a command', async () => {
    await boot({ targets: [target({ kind: 'http', config: { url: 'https://x', method: 'POST' } })] });

    click(rowButton('target-table', 'Run'));
    await settle();
    assert.match(doc.querySelector('.modal-overlay').textContent, /sends the real request configured for "nas"/);
  });

  test('the outcome is reported, and the page re-read afterwards', async () => {
    await boot({ targets: [target()] });
    overrideFetch(
      (path, init) => init?.method === 'POST',
      async () => ({ ok: true, status: 200, json: async () => ({ ok: false, message: 'exit status 1' }) })
    );

    click(rowButton('target-table', 'Run'));
    await settle();
    click(dialogButtons().confirm);
    await settle();

    const dialog = doc.querySelector('.modal-overlay');
    assert.match(dialog.textContent, /Action failed/);
    assert.match(dialog.textContent, /exit status 1/);

    click(dialogButtons().confirm);
    await settle();
    assert.ok(paths().filter((p) => p === '/api/actions/targets').length >= 2);
  });

  test('backing out sends nothing', async () => {
    await boot({ targets: [target()] });

    click(rowButton('target-table', 'Run'));
    await settle();
    click(dialogButtons().cancel);
    await settle();
    assert.deepEqual(paths('POST'), []);
  });
});

describe('the Restore button', () => {
  const restoreBtn = () => rowButton('target-table', 'Restore');

  const withRestore = (over = {}) => target({
    config: {
      host: '10.1.20.50', port: 22, username: 'root', command: 'shutdown -h now',
      restore_enabled: true, restore_kind: 'wol', wol_mac: 'AA:BB:CC:DD:EE:FF',
      wake_mode: 'packet', wol_broadcast: '', restore_wait_seconds: 120,
      post_restore_kind: 'none',
      ...over
    }
  });

  test('a target with no restore configured cannot be restored, and says why', async () => {
    await boot({ targets: [target()] });

    assert.equal(restoreBtn().disabled, true);
    assert.equal(restoreBtn().getAttribute('title'),
      'No restore configured for this target — set one up in the edit form');
  });

  test('the tooltip spells the sequence out, numbered', async () => {
    await boot({ targets: [withRestore()] });

    assert.deepEqual(restoreBtn().getAttribute('title').split('\n'), [
      '1. Wake AA:BB:CC:DD:EE:FF with a magic packet to every attached network.',
      '2. Wait up to 120s for the target to answer.'
    ]);
  });

  test('a relay wake names the relay rather than the broadcast', async () => {
    await boot({
      targets: [withRestore({ wake_mode: 'relay', wake_relay_id: 1 })],
      relays: [relay()]
    });
    assert.match(restoreBtn().getAttribute('title'), /Ask relay "VLAN20" to wake AA:BB:CC:DD:EE:FF\./);
  });

  test('a relay that has since been deleted is named by number, not dropped', async () => {
    await boot({ targets: [withRestore({ wake_mode: 'relay', wake_relay_id: 7 })] });
    assert.match(restoreBtn().getAttribute('title'), /Ask relay "#7" to wake/);
  });

  test('a post-restore action takes over the wait, and adds its own step', async () => {
    await boot({
      targets: [withRestore({
        post_restore_kind: 'ssh', post_restore_command: 'systemctl start app'
      })]
    });

    assert.deepEqual(restoreBtn().getAttribute('title').split('\n'), [
      '1. Wake AA:BB:CC:DD:EE:FF with a magic packet to every attached network.',
      '2. Wait up to 120s for SSH to answer.',
      '3. Then run over SSH: systemctl start app'
    ]);
  });

  test('a cluster restore lists only the parts that are switched on', async () => {
    await boot({
      targets: [target({
        kind: 'k8s',
        config: {
          api_url: 'https://x:6443', action: 'drain',
          restore_enabled: true, restore_kind: 'k8s', restore_wait_seconds: 90,
          restore_uncordon: true, restore_restart_deployments: false,
          restore_method: 'PATCH', restore_path: '', post_restore_kind: 'none'
        }
      })]
    });

    assert.deepEqual(restoreBtn().getAttribute('title').split('\n'), [
      '1. Wait up to 90s for the API server to answer.',
      '2. Uncordon every node.'
    ]);
  });

  test('auto-restore is called out above the steps', async () => {
    await boot({ targets: [withRestore({ auto_restore: true })] });
    assert.match(restoreBtn().getAttribute('title'), /^Auto-restore is ON for this target\.\n/);
  });

  test('confirming runs it and reports that it started', async () => {
    await boot({ targets: [withRestore()] });
    overrideFetch(
      (path, init) => init?.method === 'POST',
      async () => ({ ok: true, status: 200, json: async () => ({ started: true, message: 'waking' }) })
    );

    click(restoreBtn());
    await settle();
    const dialog = doc.querySelector('.modal-overlay');
    assert.match(dialog.textContent, /runs the restore sequence for "nas" immediately/);
    assert.match(dialog.textContent, /1\. Wake AA:BB:CC:DD:EE:FF/, 'the same steps as the tooltip');

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('POST'), ['/api/actions/targets/1/restore']);
    assert.match(doc.querySelector('.modal-overlay').textContent, /Restore started/);
  });

  test('a restore already running is not offered a second one', async () => {
    await boot({
      targets: [withRestore({ }), ].map((t) => ({ ...t, restore_progress: { phase: 'waiting for SSH', startedAt: NOW } }))
    });

    assert.equal(restoreBtn(), undefined, 'the button reads "Restoring…" instead');
    const btn = [...doc.querySelectorAll('#target-table tbody button')].find((b) => b.textContent === 'Restoring…');
    assert.equal(btn.disabled, true);
    assert.equal(btn.title, 'Restore in progress: waiting for SSH');
  });
});

// ---------- a restore in flight ----------

describe('a restore in flight', () => {
  const running = (phase = 'waiting for SSH', startedAt = NOW - 65_000) =>
    target({ restore_progress: { phase, startedAt } });

  test('the activity cell shows the phase and how long it has been going', async () => {
    await boot({ targets: [running()] });

    const cell = doc.querySelector('#target-table .restoring-cell');
    assert.equal(text('.pill', cell), 'restoring');
    assert.equal(text('.time', cell), '1m 05s');
    assert.equal(text('.phase', cell), 'waiting for SSH');
    assert.match(cell.getAttribute('title'), /waiting for SSH — 65s elapsed/);
  });

  test('under a minute it is counted in plain seconds', async () => {
    await boot({ targets: [running('waking', NOW - 42_000)] });
    assert.equal(text('#target-table .restoring-cell .time'), '42s');
  });

  test('the phase is polled every three seconds while it runs', async () => {
    await boot({ targets: [running()] });
    const before = paths().length;

    mock.timers.tick(2999);
    await settle();
    assert.equal(paths().length, before, 'not yet');

    overrideFetch(
      (path) => path === '/api/actions/targets/1/restore',
      async () => ({ ok: true, status: 200, json: async () => ({ running: true, progress: { phase: 'running command', startedAt: NOW - 65_000 } }) })
    );
    mock.timers.tick(1);
    await settle();

    assert.deepEqual(paths().slice(before), ['/api/actions/targets/1/restore']);
    assert.equal(text('#target-table .restoring-cell .phase'), 'running command');
  });

  test('it keeps polling for as long as the restore runs', async () => {
    await boot({ targets: [running()] });
    overrideFetch(
      (path) => path === '/api/actions/targets/1/restore',
      async () => ({ ok: true, status: 200, json: async () => ({ running: true, progress: { phase: 'waiting', startedAt: NOW } }) })
    );

    for (let i = 0; i < 3; i++) {
      mock.timers.tick(3000);
      await settle();
    }
    assert.equal(paths().filter((p) => p === '/api/actions/targets/1/restore').length, 3);
  });

  test('once it finishes the row goes back to its last activity, and the page is re-read', async () => {
    await boot({ targets: [running()] });
    overrideFetch(
      (path) => path === '/api/actions/targets/1/restore',
      async () => ({
        ok: true, status: 200,
        json: async () => ({ running: false, last_activity: { ts: NOW, trigger: 'restore' } })
      })
    );

    mock.timers.tick(3000);
    await settle();

    assert.equal(doc.querySelector('#target-table .restoring-cell'), null);
    assert.match(rows('target-table')[0][6], /\(restore\)$/);
    assert.ok(paths().filter((p) => p === '/api/actions/targets').length >= 2,
      'a full refresh picks up the health dot the restore moved');
  });

  test('a failed poll leaves the row as it was and tries again', async () => {
    await boot({ targets: [running()] });
    overrideFetch(
      (path) => path === '/api/actions/targets/1/restore',
      async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
    );

    mock.timers.tick(3000);
    await settle();
    assert.equal(text('#target-table .restoring-cell .phase'), 'waiting for SSH', 'left alone');

    mock.timers.tick(3000);
    await settle();
    assert.equal(paths().filter((p) => p === '/api/actions/targets/1/restore').length, 2,
      'the loop did not die with the request');
  });
});

// ---------- the target form ----------

describe('the target form', () => {
  const section = (kind) => doc.querySelector(`.kind-section[data-kind="${kind}"]`);

  test('only the chosen kind\'s fields are shown', async () => {
    await boot();
    assert.equal(shown(section('ssh')), true, 'SSH is the first option');
    assert.equal(shown(section('k8s')), false);

    chooseKind('k8s');
    assert.equal(shown(section('k8s')), true);
    assert.equal(shown(section('ssh')), false);
  });

  test('SSH\'s credentials follow its auth method', async () => {
    await boot();
    const password = doc.querySelector('[data-ssh-auth="password"]');
    const key = doc.querySelector('[data-ssh-auth="key"]');
    assert.equal(shown(password), true);
    assert.equal(shown(key), false);

    tField('ssh_auth_method').value = 'key';
    change(tField('ssh_auth_method'));
    assert.equal(shown(password), false);
    assert.equal(shown(key), true);
  });

  test('WinRM\'s certificate fields appear only over HTTPS', async () => {
    await boot();
    chooseKind('winrm');
    const tls = doc.querySelector('.winrm-tls');
    assert.equal(tls.hidden, true, 'plain HTTP is the default');

    tField('winrm_use_tls').checked = true;
    change(tField('winrm_use_tls'));
    assert.equal(tls.hidden, false);
  });

  test('toggling the WinRM transport moves the port, but never one typed by hand', async () => {
    await boot();
    chooseKind('winrm');
    const port = tField('winrm_port');
    assert.equal(port.value, '5985');

    tField('winrm_use_tls').checked = true;
    change(tField('winrm_use_tls'));
    assert.equal(port.value, '5986', 'the default follows the transport');

    tField('winrm_use_tls').checked = false;
    change(tField('winrm_use_tls'));
    assert.equal(port.value, '5985');

    port.value = '5999';
    tField('winrm_use_tls').checked = true;
    change(tField('winrm_use_tls'));
    assert.equal(port.value, '5999', 'a port set deliberately is left alone');
  });

  test('the cluster\'s custom-request fields appear only for a custom action', async () => {
    await boot();
    chooseKind('k8s');
    const custom = doc.querySelector('[data-k8s-action="custom"]');
    assert.equal(shown(custom), false, 'drain is the default');

    tField('k8s_action').value = 'custom';
    change(tField('k8s_action'));
    assert.equal(shown(custom), true);
  });

  test('the http login block appears only for the login scheme', async () => {
    await boot();
    chooseKind('http');
    const login = doc.querySelector('[data-http="login"]');
    const token = tField('http_token').closest('label');
    assert.equal(shown(login), false);

    const scheme = doc.getElementById('http-auth-scheme');
    scheme.value = 'bearer';
    change(scheme);
    assert.equal(shown(token), true, 'one label serves bearer and header');
    assert.equal(shown(login), false);

    scheme.value = 'login';
    change(scheme);
    assert.equal(shown(login), true);
    assert.equal(shown(token), false);
  });

  test('inside the login block, only the field naming where the token is', async () => {
    await boot();
    chooseKind('http');
    const scheme = doc.getElementById('http-auth-scheme');
    scheme.value = 'login';
    change(scheme);

    const fromJson = doc.querySelector('[data-token-source="json"]');
    const fromCookie = doc.querySelector('[data-token-source="cookie"]');
    assert.equal(shown(fromJson), true, 'a JSON body is the default');
    assert.equal(shown(fromCookie), false);

    const source = doc.querySelector('[data-token-source-select]');
    source.value = 'cookie';
    change(source);
    assert.equal(shown(fromJson), false);
    assert.equal(shown(fromCookie), true);
  });

  test('editing fills the connection, retitles the form and reveals that kind', async () => {
    await boot({
      targets: [target({
        id: 4, name: 'esx', kind: 'winrm', enabled: 0,
        config: { host: '10.0.0.7', port: 5986, domain: 'CORP', username: 'svc', command: 'stop-computer' }
      })]
    });

    click(rowButton('target-table', 'Edit'));

    assert.equal(text('#target-form-title'), 'Edit target: esx');
    assert.equal(text('#target-submit'), 'Save changes');
    assert.equal(doc.getElementById('t-kind').value, 'winrm');
    assert.equal(tField('winrm_host').value, '10.0.0.7');
    assert.equal(tField('winrm_port').value, '5986');
    assert.equal(tField('winrm_domain').value, 'CORP');
    assert.equal(tField('winrm_username').value, 'svc');
    assert.equal(tField('winrm_command').value, 'stop-computer');
    assert.equal(tField('enabled').checked, false);
    assert.equal(shown(section('winrm')), true);
  });

  test('a target saved before send_cookies existed keeps sending them', async () => {
    await boot({
      targets: [target({ kind: 'http', config: { url: 'https://x', method: 'POST' } })]
    });
    click(rowButton('target-table', 'Edit'));

    assert.equal(tField('http_send_cookies').checked, true,
      'ticked by default for a new target, so an older one must not silently turn it off');
  });

  test('adding sends the connection, the action and only the credentials typed', async () => {
    await boot();

    tField('name').value = 'nas';
    tField('ssh_host').value = '10.1.20.50';
    tField('ssh_username').value = 'root';
    tField('ssh_command').value = 'shutdown -h now';
    tField('ssh_password').value = 'pw';

    submit(tForm());
    await settle();

    assert.deepEqual(paths('POST'), ['/api/actions/targets']);
    const body = sent('POST');
    assert.equal(body.name, 'nas');
    assert.equal(body.kind, 'ssh');
    assert.equal(body.config.host, '10.1.20.50');
    assert.equal(body.config.port, 22, 'the default fills in for a blank port');
    assert.equal(body.config.command, 'shutdown -h now');
    assert.deepEqual(body.secrets, { password: 'pw' });
  });

  test('a blank credential is omitted so the stored one survives an edit', async () => {
    await boot({ targets: [target({ id: 4, secret_fields: ['password'] })] });
    click(rowButton('target-table', 'Edit'));

    submit(tForm());
    await settle();
    assert.deepEqual(paths('PUT'), ['/api/actions/targets/4']);
    assert.deepEqual(sent('PUT').secrets, {});
  });

  test('clearing a stored credential sends an explicit null', async () => {
    await boot({ targets: [target({ id: 4, secret_fields: ['password'] })] });
    click(rowButton('target-table', 'Edit'));

    click([...doc.querySelectorAll('#target-form .secret-state .link-btn')].find((b) => b.textContent === 'clear'));
    submit(tForm());
    await settle();
    assert.deepEqual(sent('PUT').secrets, { password: null });
  });

  test('a rejected save is shown on the form', async () => {
    await boot();
    overrideFetch(
      (path, init) => init?.method === 'POST',
      async () => ({ ok: false, status: 400, json: async () => ({ error: 'host is required' }) })
    );

    submit(tForm());
    await settle();
    assert.equal(text('#target-error'), 'host is required');
  });

  test('deleting warns the credentials and any group step go with it', async () => {
    await boot({ targets: [target({ id: 4 })] });

    click(rowButton('target-table', 'Delete'));
    await settle();
    assert.match(doc.querySelector('.modal-overlay').textContent,
      /"nas" and its stored credentials will be permanently deleted/);
    assert.match(doc.querySelector('.modal-overlay').textContent,
      /Any action group step that runs it will stop working/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('DELETE'), ['/api/actions/targets/4']);
  });

  describe('the Test connection button', () => {
    test('says what it is doing, then reports the result', async () => {
      await boot();
      overrideFetch(
        (path) => path === '/api/actions/targets/test',
        async () => ({ ok: true, status: 200, json: async () => ({ ok: true, message: 'connected' }) })
      );

      click(doc.getElementById('target-test'));
      assert.equal(text('#target-test-result'), 'Testing…');

      await settle();
      assert.equal(text('#target-test-result'), '✓ connected');
    });

    test('an http target is warned that its test IS the real request', async () => {
      await boot();
      chooseKind('http');

      click(doc.getElementById('target-test'));
      assert.equal(text('#target-test-result'), 'Sending test request…');
      await settle();
    });

    test('an http target that logs in has a safe probe, and says so', async () => {
      await boot();
      chooseKind('http');
      const scheme = doc.getElementById('http-auth-scheme');
      scheme.value = 'login';
      change(scheme);

      click(doc.getElementById('target-test'));
      assert.equal(text('#target-test-result'), 'Logging in…');
      await settle();
    });

    test('a failure is marked as one', async () => {
      await boot();
      overrideFetch(
        (path) => path === '/api/actions/targets/test',
        async () => ({ ok: true, status: 200, json: async () => ({ ok: false, message: 'auth failed' }) })
      );

      click(doc.getElementById('target-test'));
      await settle();
      assert.equal(text('#target-test-result'), '✕ auth failed');
      assert.equal(doc.getElementById('target-test-result').className, 'error');
    });
  });
});

// ---------- the Restore panel ----------

describe('the Restore panel', () => {
  const config = () => doc.getElementById('restore-config');
  const summary = () => text('#restore-summary');

  test('it is off by default, and the summary says so from behind the fold', async () => {
    await boot();
    assert.equal(shown(config()), false);
    assert.equal(summary(), 'off');
  });

  test('turning it on reveals it, and the summary describes what it does', async () => {
    await boot();
    configureRestore({ kind: 'wol' });

    assert.equal(shown(config()), true);
    assert.equal(summary(), 'no wake', 'a wake with no MAC wakes nothing');

    tField('wol_mac').value = 'AA:BB:CC:DD:EE:FF';
    input(tField('wol_mac'));
    assert.equal(summary(), 'wake');
  });

  test('the summary carries the second step and the auto flag', async () => {
    await boot();
    configureRestore({ kind: 'wol', post: 'ssh' });
    tField('wol_mac').value = 'AA:BB:CC:DD:EE:FF';
    tField('auto_restore').checked = true;
    change(tField('auto_restore'));

    assert.equal(summary(), 'wake · then SSH · auto');
  });

  describe('step 1 — the restore itself', () => {
    test('a wake shows the wake fields and no connection block', async () => {
      await boot();
      configureRestore({ kind: 'wol' });

      assert.equal(shown(doc.querySelector('[data-rk="wol"]')), true);
      assert.equal(shown(doc.getElementById('restore-connection')), false,
        'a magic packet connects to nothing');
    });

    test('a cluster restore swaps the wake fields for a connection', async () => {
      await boot();
      configureRestore({ kind: 'k8s' });

      assert.equal(shown(doc.querySelector('[data-rk="wol"]')), false);
      assert.equal(shown(doc.getElementById('restore-connection')), true);
      assert.equal(shown(tField('restore_api_url').closest('label')), true);
    });

    test('the cluster\'s credential follows its sign-in choice', async () => {
      await boot();
      configureRestore({ kind: 'k8s' });

      const token = tField('restore_token').closest('label');
      const kubeconfig = tField('restore_kubeconfig').closest('label');
      assert.equal(shown(token), true, 'a token is the default');
      assert.equal(shown(kubeconfig), false);

      tField('restore_k8s_auth').value = 'kubeconfig';
      change(tField('restore_k8s_auth'));
      assert.equal(shown(token), false);
      assert.equal(shown(kubeconfig), true);
    });

    test('an http restore shows nothing extra until a scheme is picked', async () => {
      await boot();
      configureRestore({ kind: 'http' });

      assert.equal(shown(tField('restore_url').closest('label')), true);
      assert.equal(shown(tField('restore_username').closest('label')), false);
      assert.equal(shown(tField('restore_token').closest('label')), false);

      tField('restore_auth_scheme').value = 'basic';
      change(tField('restore_auth_scheme'));
      assert.equal(shown(tField('restore_username').closest('label')), true);
      assert.equal(shown(tField('restore_password').closest('label')), true);
      assert.equal(shown(tField('restore_token').closest('label')), false);

      tField('restore_auth_scheme').value = 'bearer';
      change(tField('restore_auth_scheme'));
      assert.equal(shown(tField('restore_token').closest('label')), true);
      assert.equal(shown(tField('restore_username').closest('label')), false);
    });

    test('"same as target" is offered only when the method matches the target', async () => {
      await boot();
      const inherit = doc.getElementById('restore-inherit-field');

      configureRestore({ kind: 'k8s' });
      assert.equal(shown(inherit), false, 'the target is SSH — there is nothing to inherit');

      chooseKind('k8s');
      configureRestore({ kind: 'k8s' });
      assert.equal(shown(inherit), true);
    });

    test('inheriting hides the connection, since there is nothing of its own to fill in', async () => {
      await boot();
      chooseKind('k8s');
      configureRestore({ kind: 'k8s', inherit: '1' });

      assert.equal(shown(doc.getElementById('restore-connection')), false);

      tField('restore_inherit').value = '0';
      change(tField('restore_inherit'));
      assert.equal(shown(doc.getElementById('restore-connection')), true);
    });

    test('switching away from a matching method hides the choice without resetting it', async () => {
      await boot();
      chooseKind('k8s');
      configureRestore({ kind: 'k8s', inherit: '1' });

      tField('restore_kind').value = 'http';
      change(tField('restore_kind'));
      assert.equal(shown(doc.getElementById('restore-inherit-field')), false);

      tField('restore_kind').value = 'k8s';
      change(tField('restore_kind'));
      assert.equal(tField('restore_inherit').value, '1',
        '"same as target" must not quietly become "its own"');
    });

    test('the request verbs offered follow the method', async () => {
      await boot();
      const select = doc.getElementById('restore-request-method');

      configureRestore({ kind: 'k8s' });
      assert.deepEqual([...select.options].map((o) => o.value), ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
      assert.equal(select.value, 'PATCH', 'the verb a cluster is usually patched with');

      tField('restore_kind').value = 'http';
      change(tField('restore_kind'));
      assert.deepEqual([...select.options].map((o) => o.value), ['GET', 'POST', 'PUT', 'DELETE']);
      assert.equal(select.value, 'POST', 'PATCH is not on offer here, so it falls back');
    });

    test('a verb both methods share survives the switch', async () => {
      await boot();
      configureRestore({ kind: 'k8s' });
      const select = doc.getElementById('restore-request-method');
      select.value = 'PUT';

      tField('restore_kind').value = 'http';
      change(tField('restore_kind'));
      assert.equal(select.value, 'PUT');
    });
  });

  describe('step 3 — the post-restore action', () => {
    test('none shows no connection at all', async () => {
      await boot();
      configureRestore({ kind: 'wol', post: 'none' });
      assert.equal(shown(doc.getElementById('post-restore-connection')), false);
    });

    test('an SSH action on an SSH target starts out reusing the target\'s connection', async () => {
      await boot();
      configureRestore({ kind: 'wol', post: 'ssh' });

      assert.equal(shown(doc.getElementById('post-restore-inherit-field')), true,
        'the methods match, so "same as target" is on offer');
      assert.equal(shown(doc.getElementById('post-restore-connection')), false,
        'and it is the default — there is nothing of its own to fill in');
      assert.equal(shown(tField('post_restore_command').closest('label')), true,
        'the command is still its own, whatever it connects over');
    });

    test('an action given its own connection shows the fields for it', async () => {
      await boot();
      configureRestore({ kind: 'wol', post: 'ssh', postInherit: '0' });

      assert.equal(shown(doc.getElementById('post-restore-connection')), true);
      assert.equal(shown(tField('post_restore_host').closest('label')), true);
      assert.equal(shown(tField('post_restore_password').closest('label')), true);
      assert.equal(shown(tField('post_restore_private_key').closest('label')), false);
    });

    test('switching that action to a key swaps the credential', async () => {
      await boot();
      configureRestore({ kind: 'wol', post: 'ssh' });

      tField('post_restore_auth_method').value = 'key';
      change(tField('post_restore_auth_method'));
      assert.equal(shown(tField('post_restore_private_key').closest('label')), true);
      assert.equal(shown(tField('post_restore_passphrase').closest('label')), true);
      assert.equal(shown(tField('post_restore_password').closest('label')), false);
    });

    test('WinRM has one way in, so it skips the sign-in axis rather than failing it', async () => {
      await boot();
      configureRestore({ kind: 'wol', post: 'winrm' });

      assert.equal(shown(tField('post_restore_password').closest('label')), true,
        'no sub-auth to match, so its own fields must still show');
      assert.equal(shown(tField('post_restore_domain').closest('label')), true);
      assert.equal(shown(tField('post_restore_command').closest('label')), true);
    });

    test('the port placeholder names the default for the method chosen', async () => {
      await boot();
      configureRestore({ kind: 'wol', post: 'ssh' });
      assert.equal(tField('post_restore_port').placeholder, '22');

      tField('post_restore_kind').value = 'winrm';
      change(tField('post_restore_kind'));
      assert.equal(tField('post_restore_port').placeholder, '5985');
    });

    test('the two steps are configured independently', async () => {
      await boot();
      configureRestore({ kind: 'k8s', post: 'http' });

      assert.equal(shown(tField('restore_api_url').closest('label')), true, 'step 1 is a cluster');
      assert.equal(shown(tField('post_restore_url').closest('label')), true, 'step 3 is an HTTP request');
      assert.equal(shown(tField('post_restore_api_url').closest('label')), false);
    });
  });

  test('everything is sent whatever the methods are, so the server can keep what it uses', async () => {
    await boot();
    configureRestore({ kind: 'wol', post: 'ssh' });
    tField('name').value = 'nas';
    tField('wol_mac').value = 'AA:BB:CC:DD:EE:FF';
    tField('post_restore_host').value = '10.1.20.50';
    tField('post_restore_command').value = 'systemctl start app';
    tField('restore_wait_seconds').value = '90';

    submit(tForm());
    await settle();

    const { config } = sent('POST');
    assert.equal(config.restore_enabled, true);
    assert.equal(config.restore_kind, 'wol');
    assert.equal(config.wol_mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(config.restore_wait_seconds, 90);
    assert.equal(config.post_restore_kind, 'ssh');
    assert.equal(config.post_restore_host, '10.1.20.50');
    assert.equal(config.post_restore_command, 'systemctl start app');
    assert.equal(config.restore_url, '', 'the unused http fields go too, as empties');
  });

  test('editing fills the panel back in from what was stored', async () => {
    await boot({
      targets: [target({
        config: {
          host: 'h', port: 22, username: 'u', command: 'c',
          restore_enabled: true, auto_restore: true, restore_wait_seconds: 45,
          restore_kind: 'http', restore_url: 'https://host/resume',
          restore_auth_scheme: 'bearer', restore_method: 'PUT',
          post_restore_kind: 'winrm', post_restore_host: '10.0.0.9', post_restore_port: 5986,
          post_restore_command: 'Start-Service app'
        }
      })]
    });

    click(rowButton('target-table', 'Edit'));

    assert.equal(tField('restore_enabled').checked, true);
    assert.equal(tField('auto_restore').checked, true);
    assert.equal(tField('restore_wait_seconds').value, '45');
    assert.equal(tField('restore_kind').value, 'http');
    assert.equal(tField('restore_url').value, 'https://host/resume');
    assert.equal(tField('restore_auth_scheme').value, 'bearer');
    assert.equal(doc.getElementById('restore-request-method').value, 'PUT',
      'the verbs are populated for the method before one is selected');
    assert.equal(tField('post_restore_kind').value, 'winrm');
    assert.equal(tField('post_restore_port').value, '5986');
    assert.equal(shown(doc.getElementById('post-restore-connection')), true);
  });

  test('a target saved before the uncordon switches existed falls back to off', async () => {
    await boot({
      targets: [target({
        kind: 'k8s',
        config: { api_url: 'https://x', restore_enabled: true, restore_kind: 'k8s' }
      })]
    });

    click(rowButton('target-table', 'Edit'));
    assert.equal(tField('restore_uncordon').checked, false,
      'both default on for a new target, so an older one must not gain them silently');
    assert.equal(tField('restore_restart_deployments').checked, false);
  });
});

// ---------- the relay-reach warning ----------

describe('the relay-reach warning', () => {
  const note = () => doc.getElementById('relay-note');

  /** Turns on a wake through a relay, with the target answering on `host`. */
  async function wakeThroughRelay(host, relays = [relay()]) {
    await boot({ relays });
    tField('ssh_host').value = host;
    configureRestore({ kind: 'wol' });
    tField('wake_mode').value = 'relay';
    change(tField('wake_mode'));
    tField('wake_relay_id').value = '1';
    change(tField('wake_relay_id'));
  }

  test('nothing is said until a relay wake is actually chosen', async () => {
    await boot({ relays: [relay()] });
    configureRestore({ kind: 'wol' });

    assert.equal(note().textContent, '', 'a broadcast packet has no relay to check');
    assert.equal(shown(doc.querySelector('[data-wake-mode="packet"]')), true);
    assert.equal(shown(doc.querySelector('[data-wake-mode="relay"]')), false);
  });

  test('a relay on the target\'s own network is confirmed', async () => {
    await wakeThroughRelay('10.1.20.50');

    assert.equal(note().textContent, "✓ 10.1.20.50 is inside this relay's network (10.1.20.0/24).");
    assert.equal(note().className, 'hint-row');
  });

  test('a relay on another network is called out — the packet would go nowhere', async () => {
    await wakeThroughRelay('10.9.0.5');

    assert.equal(note().className, 'error');
    assert.match(note().textContent, /⚠ 10\.9\.0\.5 is not inside this relay's network \(10\.1\.20\.0\/24\)/);
    assert.match(note().textContent, /a magic packet sent from there will not reach it/);
    assert.match(note().textContent, /Pick a relay on the target's own network/);
  });

  test('a hostname cannot be checked here, and the warning says so rather than guessing', async () => {
    await wakeThroughRelay('nas.lan');

    assert.equal(note().className, 'hint-row');
    assert.match(note().textContent, /"nas\.lan" is a name, not an address/);
    assert.match(note().textContent, /make sure it resolves inside that network/);
  });

  test('with no relay picked yet there is nothing to warn about', async () => {
    await boot({ relays: [relay()] });
    tField('ssh_host').value = '10.9.0.5';
    configureRestore({ kind: 'wol' });
    tField('wake_mode').value = 'relay';
    change(tField('wake_mode'));

    assert.equal(note().textContent, '');
  });

  test('the warning follows the host as it is typed', async () => {
    await wakeThroughRelay('10.1.20.50');
    assert.match(note().textContent, /^✓/);

    tField('ssh_host').value = '10.9.0.5';
    input(tField('ssh_host'));
    assert.equal(note().className, 'error');
  });

  test('a post-restore action\'s own host is what gets checked, not the target\'s', async () => {
    await boot({ relays: [relay()] });
    tField('ssh_host').value = '10.1.20.50';
    configureRestore({ kind: 'wol', post: 'ssh' });
    tField('post_restore_inherit').value = '0';
    change(tField('post_restore_inherit'));
    tField('post_restore_host').value = '10.9.0.5';
    input(tField('post_restore_host'));
    tField('wake_mode').value = 'relay';
    change(tField('wake_mode'));
    tField('wake_relay_id').value = '1';
    change(tField('wake_relay_id'));

    assert.match(note().textContent, /10\.9\.0\.5 is not inside/,
      'the wake has to reach whatever the restore connects to next');
  });

  test('an inheriting post-restore action falls back to the target\'s own address', async () => {
    await boot({ relays: [relay()] });
    tField('ssh_host').value = '10.1.20.50';
    configureRestore({ kind: 'wol', post: 'ssh', postInherit: '1' });
    tField('post_restore_host').value = '10.9.0.5';
    tField('wake_mode').value = 'relay';
    change(tField('wake_mode'));
    tField('wake_relay_id').value = '1';
    change(tField('wake_relay_id'));

    assert.match(note().textContent, /✓ 10\.1\.20\.50 is inside/);
  });

  test('a cluster target is checked on its API server\'s hostname', async () => {
    await boot({ relays: [relay()] });
    chooseKind('k8s');
    tField('k8s_api_url').value = 'https://10.1.20.60:6443';
    configureRestore({ kind: 'wol' });
    tField('wake_mode').value = 'relay';
    change(tField('wake_mode'));
    tField('wake_relay_id').value = '1';
    change(tField('wake_relay_id'));

    assert.match(note().textContent, /✓ 10\.1\.20\.60 is inside/);
  });

  test('an unparseable URL is treated as no address at all, not as a crash', async () => {
    await boot({ relays: [relay()] });
    chooseKind('k8s');
    tField('k8s_api_url').value = 'not a url';
    configureRestore({ kind: 'wol' });
    tField('wake_mode').value = 'relay';
    change(tField('wake_mode'));
    tField('wake_relay_id').value = '1';
    change(tField('wake_relay_id'));

    assert.equal(note().textContent, '');
  });
});

// ---------- the relay picker ----------

describe('the relay picker', () => {
  const picker = () => tField('wake_relay_id');

  test('with no relays it says so rather than offering an empty list', async () => {
    await boot();
    assert.deepEqual([...picker().options].map((o) => o.textContent), ['no relays configured yet']);
  });

  test('each relay is listed with its type', async () => {
    await boot({ relays: [relay(), relay({ id: 2, name: 'Lab', kind: 'winrm' })] });

    assert.deepEqual([...picker().options].map((o) => o.textContent),
      ['select a relay…', 'VLAN20 (SSH)', 'Lab (WinRM)']);
  });

  test('a paused relay is still offered, marked', async () => {
    await boot({ relays: [relay({ enabled: 0 })] });
    assert.match([...picker().options][1].textContent, /VLAN20 \(SSH\) — disabled$/);
  });

  test('a relay deleted underneath a selection stays visible rather than becoming another one', async () => {
    await boot({ relays: [relay(), relay({ id: 2, name: 'Lab' })] });
    picker().value = '2';

    data.relays = [relay()];
    mock.timers.tick(20_000);
    await settle();

    assert.equal(picker().value, '2', 'not silently re-pointed at the first relay');
    assert.equal([...picker().options].at(-1).textContent, 'deleted relay 2');
  });
});

// ---------- the action group table ----------

describe('the action group table', () => {
  test('a row carries the switch, name, stages, failure rule and assignment count', async () => {
    await boot({
      targets: [target(), target({ id: 2, name: 'esx' })],
      igroups: [igroup({
        assigned_count: 2,
        stages: [stage({ steps: [{ target_id: 1, timeout_seconds: 60 }] })]
      })]
    });

    const row = rows('igroup-table')[0];
    assert.equal(row[0], 'ENABLED');
    assert.equal(row[1], 'Shutdown');
    assert.equal(row[2], '1. nas');
    assert.equal(row[3], 'continue');
    assert.equal(row[4], '2 Flatline group(s)');
  });

  test('parallel steps are joined, a wait splits them and stages are chained', async () => {
    await boot({
      targets: [target(), target({ id: 2, name: 'esx' }), target({ id: 3, name: 'ups' })],
      igroups: [igroup({
        stages: [
          stage({ steps: [
            { target_id: 1, timeout_seconds: 60 },
            { target_id: 2, timeout_seconds: 60 },
            { wait_seconds: 10 },
            { target_id: 3, timeout_seconds: 60 }
          ] }),
          stage({ wait_seconds: 30, steps: [{ target_id: 3, timeout_seconds: 60 }] })
        ]
      })]
    });

    assert.equal(rows('igroup-table')[0][2],
      '1. nas + esx, wait 10s, ups  →(30s)→  2. ups');
  });

  test('stages with no gap between them are chained without one', async () => {
    await boot({
      targets: [target()],
      igroups: [igroup({
        stages: [
          stage({ steps: [{ target_id: 1, timeout_seconds: 60 }] }),
          stage({ wait_seconds: 0, steps: [{ target_id: 1, timeout_seconds: 60 }] })
        ]
      })]
    });
    assert.equal(rows('igroup-table')[0][2], '1. nas  →  2. nas');
  });

  test('a step naming a target that is gone is marked, not left blank', async () => {
    await boot({
      igroups: [igroup({ stages: [stage({ steps: [{ target_id: 99, timeout_seconds: 60 }] })] })]
    });
    assert.equal(rows('igroup-table')[0][2], '1. ?');
  });

  test('a group with no stages shows a dash', async () => {
    await boot({ igroups: [igroup()] });
    assert.equal(rows('igroup-table')[0][2], '—');
  });

  test('a stage overriding the group rule is flagged on the row', async () => {
    await boot({
      targets: [target()],
      igroups: [igroup({
        on_failure: 'stop',
        stages: [stage({ on_failure: 'continue', steps: [{ target_id: 1, timeout_seconds: 60 }] })]
      })]
    });
    assert.equal(rows('igroup-table')[0][3], 'stop sequence · overrides');
  });

  test('deleting says the targets survive it', async () => {
    await boot({ igroups: [igroup({ id: 3 })] });

    click(rowButton('igroup-table', 'Delete'));
    await settle();
    assert.match(doc.querySelector('.modal-overlay').textContent,
      /The action targets it uses are still available, only this sequence of steps is removed/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('DELETE'), ['/api/actions/groups/3']);
  });
});

// ---------- the stage editor ----------

describe('the stage editor', () => {
  const stageCards = () => [...doc.querySelectorAll('#stage-list .stage-card')];
  const stepRows = (si = 0) => [...stageCards()[si].querySelectorAll('.step-row')];
  const addStage = () => doc.getElementById('stage-add-btn');
  const btnIn = (root, label) => [...root.querySelectorAll('button')].find((b) => b.textContent === label);

  /** Adds one stage holding the first target. */
  function addStageWithTarget(si = 0) {
    click(addStage());
    click(btnIn(stageCards()[si], '+ Add target'));
  }

  test('with no stages it explains what one is for', async () => {
    await boot({ targets: [target()] });
    assert.match(text('#stage-list'), /No stages yet — add one, then add targets to it/);
  });

  test('a stage cannot be added before there is anything to put in it', async () => {
    await boot();
    assert.equal(addStage().disabled, true);
  });

  test('adding a stage, then a target to it', async () => {
    await boot({ targets: [target()] });
    click(addStage());

    assert.equal(stageCards().length, 1);
    assert.match(stageCards()[0].textContent, /Stage 1/);
    assert.match(stageCards()[0].textContent, /No targets yet — add one below/);

    click(btnIn(stageCards()[0], '+ Add target'));
    assert.deepEqual(stepRows().map((r) => r.querySelector('.step-name').textContent), ['nas (SSH)']);
  });

  test('a target already in the stage is not offered again', async () => {
    await boot({ targets: [target(), target({ id: 2, name: 'esx' })] });
    addStageWithTarget();

    const select = stageCards()[0].querySelector('.step-add select');
    assert.deepEqual([...select.options].map((o) => o.textContent), ['esx (SSH)']);

    click(btnIn(stageCards()[0], '+ Add target'));
    assert.equal(select.disabled, false, 'the select is rebuilt each render');
    assert.deepEqual([...stageCards()[0].querySelectorAll('.step-add select option')].map((o) => o.textContent),
      ['all targets already in this stage']);
    assert.equal(btnIn(stageCards()[0], '+ Add target').disabled, true);
  });

  test('the same target may be reused in another stage, and is flagged where it is', async () => {
    await boot({ targets: [target()] });
    addStageWithTarget(0);
    addStageWithTarget(1);

    assert.equal(stageCards().length, 2);
    for (const si of [0, 1]) {
      assert.match(stepRows(si)[0].textContent, /\(Appears in Stage 1, 2\)/);
    }
  });

  test('a wait splits the stage, and says which half it gates', async () => {
    await boot({ targets: [target(), target({ id: 2, name: 'esx' })] });
    addStageWithTarget();

    click(btnIn(stageCards()[0], '+ Add wait'));
    assert.match(stepRows()[1].textContent, /⏱ Wait \(holds the stage open at the end\)/);

    click(btnIn(stageCards()[0], '+ Add target'));
    assert.match(stepRows()[1].textContent, /\(everything below starts after this\)/);
  });

  test('the stage says how long its worst case takes, counting waits and the slowest target', async () => {
    await boot({ targets: [target(), target({ id: 2, name: 'esx' })] });
    addStageWithTarget();
    click(btnIn(stageCards()[0], '+ Add wait'));
    click(btnIn(stageCards()[0], '+ Add target'));

    // 60s for the first batch, 5s of wait, 60s for the second.
    assert.match(text('.stage-title'), /takes up to 125s/);
  });

  test('a step timeout is clamped to what the server accepts', async () => {
    await boot({ targets: [target()] });
    addStageWithTarget();

    const timeout = stageCards()[0].querySelector('.step-timeout');
    timeout.value = '9000';
    change(timeout);
    assert.equal(stageCards()[0].querySelector('.step-timeout').value, '3600');

    const again = stageCards()[0].querySelector('.step-timeout');
    again.value = '1';
    change(again);
    assert.equal(stageCards()[0].querySelector('.step-timeout').value, '5');
  });

  test('stages can be reordered, and the first has no gap before it', async () => {
    await boot({ targets: [target(), target({ id: 2, name: 'esx' })] });
    click(addStage());
    click(btnIn(stageCards()[0], '+ Add target')); // nas
    click(addStage());
    const second = stageCards()[1].querySelector('.step-add select');
    second.value = '2';
    click(btnIn(stageCards()[1], '+ Add target')); // esx

    assert.equal(doc.querySelectorAll('#stage-list .stage-wait').length, 1,
      'a gap sits between two cards, never before the first');
    assert.equal(btnIn(stageCards()[0], '↑').disabled, true);
    assert.equal(btnIn(stageCards()[1], '↓').disabled, true);

    click(btnIn(stageCards()[1], '↑'));
    assert.deepEqual(stageCards().map((c) => c.querySelector('.step-name').textContent),
      ['esx (SSH)', 'nas (SSH)']);
  });

  test('a step can be moved within its stage', async () => {
    await boot({ targets: [target(), target({ id: 2, name: 'esx' })] });
    addStageWithTarget();
    click(btnIn(stageCards()[0], '+ Add target'));

    assert.deepEqual(stepRows().map((r) => r.querySelector('.step-name').textContent), ['nas (SSH)', 'esx (SSH)']);
    click(btnIn(stepRows()[1], '↑'));
    assert.deepEqual(stepRows().map((r) => r.querySelector('.step-name').textContent), ['esx (SSH)', 'nas (SSH)']);
  });

  test('a step, and a whole stage, can be removed', async () => {
    await boot({ targets: [target()] });
    addStageWithTarget();

    click(btnIn(stepRows()[0], '✕'));
    assert.equal(stepRows().length, 0);

    click(btnIn(stageCards()[0].querySelector('.stage-btns'), '✕'));
    assert.equal(stageCards().length, 0);
  });

  test('the pass rule is offered only once a stage holds more than one step', async () => {
    await boot({ targets: [target(), target({ id: 2, name: 'esx' })] });
    addStageWithTarget();
    assert.equal(stageCards()[0].querySelectorAll('.stage-failure select').length, 1,
      'one target — only the failure override');

    click(btnIn(stageCards()[0], '+ Add target'));
    const selects = stageCards()[0].querySelectorAll('.stage-failure select');
    assert.equal(selects.length, 2);
    assert.deepEqual([...selects[0].options].map((o) => o.textContent), ['any target fails', 'all targets fail']);
  });

  test('what the editor holds is what gets sent, minus the stages left empty', async () => {
    await boot({ targets: [target(), target({ id: 2, name: 'esx' })] });
    addStageWithTarget();
    click(btnIn(stageCards()[0], '+ Add wait'));
    click(addStage()); // left empty on purpose

    const failure = stageCards()[0].querySelectorAll('.stage-failure select');
    failure[failure.length - 1].value = 'stop';
    change(failure[failure.length - 1]);

    doc.getElementById('igroup-form').elements.namedItem('name').value = 'Shutdown';
    submit(doc.getElementById('igroup-form'));
    await settle();

    assert.deepEqual(paths('POST'), ['/api/actions/groups']);
    assert.deepEqual(sent('POST').stages, [{
      pass_rule: 'any', on_failure: 'stop', wait_seconds: 5,
      steps: [{ target_id: 1, timeout_seconds: 60 }, { wait_seconds: 5 }]
    }]);
  });

  test('editing rebuilds the stages from what was stored', async () => {
    await boot({
      targets: [target(), target({ id: 2, name: 'esx' })],
      igroups: [igroup({
        id: 3, on_failure: 'stop', stop_on_restore: 1,
        stages: [
          stage({ pass_rule: 'all', steps: [{ target_id: 1, timeout_seconds: 30 }] }),
          // wait_seconds is the gap held *before* this stage, so it is what the
          // one editable row between the two cards shows.
          stage({ wait_seconds: 12, steps: [{ target_id: 2, timeout_seconds: 45 }, { wait_seconds: 20 }] })
        ]
      })]
    });

    click(rowButton('igroup-table', 'Edit'));

    assert.equal(text('#igroup-form-title'), 'Edit group: Shutdown');
    assert.equal(doc.getElementById('igroup-form').elements.namedItem('on_failure').value, 'stop');
    assert.equal(doc.getElementById('igroup-form').elements.namedItem('stop_on_restore').checked, true);
    assert.equal(stageCards().length, 2);
    assert.equal(doc.querySelector('#stage-list .stage-wait input').value, '12');
    assert.equal(stepRows(0)[0].querySelector('.step-timeout').value, '30');
    assert.match(stepRows(1)[1].textContent, /⏱ Wait/);
  });
});

// ---------- assigning Flatline groups ----------

describe('assigning Flatline groups', () => {
  const boxes = () => [...doc.querySelectorAll('#ig-flatline-group-checks input[data-flatline-group]')];

  test('with none defined it points at the page that makes one', async () => {
    await boot();

    assert.equal(boxes().length, 0);
    assert.match(text('#ig-flatline-group-checks'), /No Flatline groups yet — create one on the Flatline page/);
    assert.equal(doc.querySelector('#ig-flatline-group-checks a').getAttribute('href'), '/flatline');
  });

  test('editing ticks the groups this action group is already assigned to', async () => {
    await boot({
      igroups: [igroup({ id: 3 })],
      flatlineGroups: [
        flatlineGroup({ id: 1, name: 'Rack', action_group_ids: [3] }),
        flatlineGroup({ id: 2, name: 'Lab', action_group_ids: [] })
      ]
    });

    click(rowButton('igroup-table', 'Edit'));
    assert.deepEqual(boxes().map((b) => b.checked), [true, false]);
  });

  test('the assignment is written to each Flatline group, since that is where it lives', async () => {
    await boot({
      flatlineGroups: [flatlineGroup({ id: 5, name: 'Rack' })]
    });

    doc.getElementById('igroup-form').elements.namedItem('name').value = 'Shutdown';
    boxes()[0].checked = true;
    submit(doc.getElementById('igroup-form'));
    await settle();

    assert.deepEqual(paths('PUT'), ['/api/groups/5']);
    assert.deepEqual(sent('PUT').action_group_ids, [1], 'the id the create came back with');
  });

  test('unticking one removes just that action group from it', async () => {
    await boot({
      igroups: [igroup({ id: 3 })],
      flatlineGroups: [flatlineGroup({ id: 5, name: 'Rack', action_group_ids: [3, 9] })]
    });

    click(rowButton('igroup-table', 'Edit'));
    boxes()[0].checked = false;
    submit(doc.getElementById('igroup-form'));
    await settle();

    assert.deepEqual(paths('PUT'), ['/api/actions/groups/3', '/api/groups/5']);
    assert.deepEqual(allSent('PUT')[1].action_group_ids, [9],
      'the other action group assigned to it is left alone');
  });

  test('leaving the assignment alone writes nothing to the Flatline groups', async () => {
    await boot({
      igroups: [igroup({ id: 3 })],
      flatlineGroups: [flatlineGroup({ id: 5, action_group_ids: [3] })]
    });

    click(rowButton('igroup-table', 'Edit'));
    submit(doc.getElementById('igroup-form'));
    await settle();

    assert.deepEqual(paths('PUT'), ['/api/actions/groups/3']);
  });
});

// ---------- staying current ----------

describe('staying current', () => {
  test('the whole page is swept every twenty seconds', async () => {
    await boot();
    const before = paths().length;

    mock.timers.tick(19_999);
    await settle();
    assert.equal(paths().length, before);

    mock.timers.tick(1);
    await settle();
    assert.deepEqual(paths().slice(before),
      ['/api/actions/targets', '/api/actions/groups', '/api/groups', '/api/relays']);
  });

  test('a nudge from the stream re-reads only the targets', async () => {
    await boot({ targets: [target()] });
    const before = paths().length;

    data.targets = [target({ health: { ok: true, checkedAt: NOW, message: 'ok' } })];
    stream.fire();
    await settle();

    assert.deepEqual(paths().slice(before), ['/api/actions/targets'],
      'a full refresh would rebuild the forms and pickers out from under whoever is using them');
    assert.equal(text('#target-table .pill'), 'UP');
  });

  test('a nudge does not disturb an edit in progress', async () => {
    await boot({ targets: [target({ id: 4 })] });
    click(rowButton('target-table', 'Edit'));
    tField('ssh_command').value = 'halt';

    stream.fire();
    await settle();

    assert.equal(text('#target-form-title'), 'Edit target: nas');
    assert.equal(tField('ssh_command').value, 'halt');
  });

  test('a failed target refresh is logged and the page left standing', async () => {
    await boot({ targets: [target()] });
    overrideFetch(
      (path) => path === '/api/actions/targets',
      async () => { throw new Error('network down'); }
    );

    const realError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args[0]);
    try {
      stream.fire();
      await settle();
    } finally {
      console.error = realError;
    }

    assert.deepEqual(logged, ['target refresh failed:']);
    assert.equal(rows('target-table').length, 1, 'the last good render stands');
  });
});

// ---------- the session snapshot ----------

describe('the session snapshot', () => {
  const KEY = 'flatline.snap.actions';
  const snapshot = (payload, ts = NOW) => JSON.stringify({ ts, data: payload });

  const held = {
    targets: [target()], igroups: [igroup()], flatlineGroups: [flatlineGroup()], relays: [relay()]
  };

  /** Boots with a snapshot in place and a fetch that never answers, so only what
   *  the snapshot painted is on the page. */
  async function bootFromSnapshot(payload) {
    env = setupDom(HTML, 'http://localhost/actions');
    doc = env.document;
    env.window.sessionStorage.setItem(KEY, snapshot(payload));
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
    installStream();
    calls = [];
    globalThis.fetch = () => new Promise(() => {});
    await importFresh(ACTIONS);
    await settle();
  }

  test('last session\'s tables are painted before the live lists arrive', async () => {
    await bootFromSnapshot(held);

    assert.equal(rows('target-table')[0][1], 'nas');
    assert.equal(rows('igroup-table')[0][1], 'Shutdown');
  });

  test('a restore that was running when it was taken is not replayed', async () => {
    await bootFromSnapshot({
      ...held,
      targets: [target({ restore_progress: { phase: 'waiting for SSH', startedAt: NOW - 5000 } })]
    });

    assert.equal(doc.querySelector('#target-table .restoring-cell'), null,
      'progress is live state — it may well have finished since');
    assert.equal(rows('target-table')[0][6], 'never');
  });

  test('leaving the page saves all four lists', async () => {
    await boot({
      targets: [target()], igroups: [igroup()], flatlineGroups: [flatlineGroup()], relays: [relay()]
    });

    env.window.dispatchEvent(new env.window.Event('pagehide'));

    const saved = JSON.parse(env.window.sessionStorage.getItem(KEY));
    assert.deepEqual(Object.keys(saved.data).sort(), ['flatlineGroups', 'igroups', 'relays', 'targets']);
    assert.deepEqual(saved.data.targets.map((t) => t.name), ['nas']);
  });

  test('a page that never finished loading saves nothing half-populated', async () => {
    const seeded = snapshot(held);
    env = setupDom(HTML, 'http://localhost/actions');
    doc = env.document;
    env.window.sessionStorage.setItem(KEY, seeded);
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
    installStream();
    calls = [];
    globalThis.fetch = () => new Promise(() => {});
    await importFresh(ACTIONS);
    await settle();

    env.window.dispatchEvent(new env.window.Event('pagehide'));
    assert.equal(env.window.sessionStorage.getItem(KEY), seeded);
  });
});
