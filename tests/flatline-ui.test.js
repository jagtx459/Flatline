import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDom, importFresh, click, flush } from './helpers/jsdom-env.js';

/**
 * public/scripts/flatline.js — the Flatline page: the endpoint table and its
 * add/edit form, the Flatline group table and its form, and the endpoint
 * checklist that ties the two together.
 *
 * Like dashboard.js this module is a page entry point rather than a library:
 * importing it boots the page and it exports nothing. Unlike the dashboard it
 * binds to static markup at module scope (`document.getElementById('group-form')`
 * and friends), so the test loads the real public/flatline.html into jsdom
 * instead of hand-writing containers. jsdom parses the file but does not run its
 * `<script type="module">`, so the import below is still what boots the page —
 * and any drift between the markup and the ids the script reaches for shows up
 * here as a failure.
 *
 * Mock timers, like the other page suites: the page itself has no poll loop —
 * it loads its three lists once and only re-reads them after an edit — but the
 * banners every page carries poll for group states, and a real interval left
 * running would keep the test process alive for good.
 *
 * Loading the real page brings the site header with it, so every boot also
 * fetches /api/version and /api/auth. `paths()` drops those — they belong to
 * header.js, which has a suite of its own.
 */

const FLATLINE = new URL('../public/scripts/flatline.js', import.meta.url).href;
const HTML = readFileSync(new URL('../public/flatline.html', import.meta.url), 'utf8');

const realFetch = globalThis.fetch;

let env;
let doc;
let data;
let calls;

// ---------- fixtures (shapes mirror listEndpoints / listFlatlineGroups in server/db.js) ----------

function endpoint(over = {}) {
  return {
    id: 1, name: 'nas', type: 'icmp', target: '10.0.0.5',
    interval_seconds: 30, timeout_ms: 5000, down_threshold: 3, up_threshold: 2,
    expect_status: null, expect_json: null, enabled: 1, last_state: 'up',
    group_ids: [], group_names: [],
    ...over
  };
}

function group(over = {}) {
  return {
    id: 1, name: 'Rack', mode: 'all', grace_minutes: 5, enabled: 1,
    endpoint_ids: [], endpoint_count: 0, action_group_ids: [],
    ...over
  };
}

const actionGroup = (over = {}) => ({ id: 1, name: 'Shutdown', ...over });

// ---------- harness ----------

/**
 * Stands up the page: a DOM holding the real markup, a fetch answering like the
 * server, then the import that boots it. `storage`/`session` seed local and
 * session storage first, for the fold state and the snapshot the module reads
 * at import time.
 */
async function boot({
  endpoints = [], groups = [], actionGroups = [], groupStates = [], storage, session, fetchImpl
} = {}) {
  env = setupDom(HTML, 'http://localhost/flatline');
  doc = env.document;
  for (const [k, v] of Object.entries(storage ?? {})) env.window.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(session ?? {})) env.window.sessionStorage.setItem(k, v);

  // Not 'Date': the snapshot tests below reckon their own staleness against the
  // real clock, and freezing it would make a minute-old snapshot look current.
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  // The banners every page carries read this; nothing armed unless a test says so.
  data = { endpoints, groups, actionGroups, groupStates };
  calls = [];
  globalThis.fetch = fetchImpl ?? defaultFetch;

  await importFresh(FLATLINE);
  await settle();
  return doc;
}

const BODIES = {
  '/api/version': () => ({ version: '1.0.0' }),
  '/api/auth': () => ({ auth_required: false }),
  '/api/endpoints': () => data.endpoints,
  '/api/groups': () => data.groups,
  '/api/groups/states': () => ({ now: Date.now(), groups: data.groupStates }),
  '/api/actions/groups': () => data.actionGroups
};

/** The list routes answer reads; a write answers with the row it saved, carrying
 *  the id from its own URL — which is what initEntityForm re-fills the form from. */
function answer(path, init) {
  const method = init?.method ?? 'GET';
  if (method === 'GET' && BODIES[path]) return BODIES[path]();
  const id = Number(path.match(/\/(\d+)$/)?.[1]) || 1;
  return { id, name: 'saved' };
}

async function defaultFetch(path, init) {
  calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, json: async () => answer(path, init) };
}

/** Lets the fetch chain and its .then callbacks run. */
const settle = () => flush(6);

afterEach(() => {
  mock.timers.reset();
  env.cleanup();
  globalThis.fetch = realFetch;
});

/** The requests the page made, less the two the shared header always makes. */
/** The requests this page made, less the ones every page makes: the header's
 *  two and the banners' group states. */
const paths = (method = 'GET') => calls
  .filter((c) => c.method === method && !SHARED_PATHS.has(c.path))
  .map((c) => c.path);

const SHARED_PATHS = new Set(['/api/version', '/api/auth', '/api/groups/states']);

const sent = (method) => calls.find((c) => c.method === method)?.body;

const submit = (form) =>
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));

const text = (sel, root = doc) => root.querySelector(sel)?.textContent ?? null;

/** One table's rows as arrays of cell text. */
const rows = (id) => [...doc.querySelectorAll(`#${id} tbody tr`)]
  .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

/** The buttons in the dialog confirmDialog() puts on the page. */
function dialogButtons() {
  const buttons = [...doc.querySelectorAll('.modal-overlay .modal-actions button')];
  return buttons.length > 1 ? { cancel: buttons[0], confirm: buttons[1] } : { cancel: null, confirm: buttons[0] };
}

/** A row's button by label, from whichever table it is in. */
const rowButton = (tableId, label) =>
  [...doc.querySelectorAll(`#${tableId} tbody button`)].find((b) => b.textContent === label);

// ---------- boot ----------

describe('boot', () => {
  test('reads the three lists it needs and renders both tables', async () => {
    await boot();

    assert.deepEqual(paths(), ['/api/groups', '/api/actions/groups', '/api/endpoints']);
    assert.match(text('#endpoint-table'), /No endpoints configured/);
    assert.match(text('#group-table'), /No Flatline groups yet/);
  });

  test('the empty states say what to do next', async () => {
    await boot();

    assert.match(text('#endpoint-table .empty'), /Add the router, UPS, or service you want to watch/);
    assert.match(text('#group-table .empty'),
      /Endpoints can be monitored without one, but only grouped endpoints can trigger actions/);
  });

  test('both forms open in add mode, folded away', async () => {
    await boot();

    assert.equal(text('#form-title'), 'Add Flatline endpoint');
    assert.equal(text('#form-submit'), 'Add endpoint');
    assert.equal(text('#group-form-title'), 'Add Flatline group');
    assert.equal(text('#group-submit'), 'Add group');
    assert.equal(doc.getElementById('form-body').style.display, 'none');
    assert.equal(doc.getElementById('group-form-body').style.display, 'none');
  });
});

// ---------- the endpoint table ----------

describe('the endpoint table', () => {
  test('a row carries the state pill, name, check, target, interval and groups', async () => {
    await boot({ endpoints: [endpoint({ group_names: ['Rack', 'Core'] })] });

    assert.deepEqual(rows('endpoint-table')[0].slice(0, 6),
      ['UP', 'nas', 'ping', '10.0.0.5', '30s', 'Rack, Core']);
  });

  test('an ungrouped endpoint shows a dash rather than an empty cell', async () => {
    await boot({ endpoints: [endpoint()] });
    assert.equal(rows('endpoint-table')[0][5], '—');
  });

  describe('the state pill', () => {
    const pill = () => doc.querySelector('#endpoint-table .pill');

    test('up', async () => {
      await boot({ endpoints: [endpoint({ last_state: 'up' })] });
      assert.equal(pill().textContent, 'UP');
      assert.equal(pill().className, 'pill up');
    });

    test('down', async () => {
      await boot({ endpoints: [endpoint({ last_state: 'down' })] });
      assert.equal(pill().textContent, 'DOWN');
      assert.equal(pill().className, 'pill down');
    });

    test('an endpoint with no state yet reads PENDING', async () => {
      await boot({ endpoints: [endpoint({ last_state: null })] });
      assert.equal(pill().textContent, 'PENDING');
      assert.equal(pill().className, 'pill unknown');
    });

    test('a paused endpoint reads DISABLED whatever its last state was', async () => {
      await boot({ endpoints: [endpoint({ enabled: 0, last_state: 'down' })] });
      assert.equal(pill().textContent, 'DISABLED');
      assert.equal(pill().className, 'pill disabled');
    });
  });

  describe('the check summary', () => {
    const check = () => rows('endpoint-table')[0][2];

    test('an icmp endpoint is just a ping', async () => {
      await boot({ endpoints: [endpoint({ type: 'icmp', expect_status: 200 })] });
      assert.equal(check(), 'ping', 'the http expectations do not apply to it');
    });

    test('a bare http endpoint', async () => {
      await boot({ endpoints: [endpoint({ type: 'http', target: 'https://x/health' })] });
      assert.equal(check(), 'http');
    });

    test('http with both expectations spells out each one', async () => {
      await boot({ endpoints: [endpoint({ type: 'http', expect_status: 204, expect_json: '{"ok":true}' })] });
      assert.equal(check(), 'http · status 204 · JSON match');
    });
  });
});

// ---------- the group table ----------

describe('the group table', () => {
  test('a row carries the switch, name, failure rule, grace, endpoints and actions', async () => {
    await boot({
      endpoints: [endpoint(), endpoint({ id: 2, name: 'sw' })],
      groups: [group({ endpoint_ids: [1, 2], action_group_ids: [1] })],
      actionGroups: [actionGroup()]
    });

    assert.deepEqual(rows('group-table')[0].slice(0, 6),
      ['ENABLED', 'Rack', 'all down', '5 min', 'nas, sw', 'Shutdown']);
  });

  test('a group that fails on any endpoint says so', async () => {
    await boot({ groups: [group({ mode: 'any' })] });
    assert.equal(rows('group-table')[0][2], 'any down');
  });

  test('a disabled group is marked as such', async () => {
    await boot({ groups: [group({ enabled: 0 })] });
    assert.equal(rows('group-table')[0][0], 'DISABLED');
  });

  test('a group with no endpoints and no actions shows dashes', async () => {
    await boot({ groups: [group()] });
    const row = rows('group-table')[0];
    assert.equal(row[4], '—');
    assert.equal(row[5], '—');
  });

  test('an id naming a row that is gone is dropped rather than printed raw', async () => {
    await boot({
      endpoints: [endpoint()],
      groups: [group({ endpoint_ids: [1, 99], action_group_ids: [99] })],
      actionGroups: [actionGroup()]
    });

    const row = rows('group-table')[0];
    assert.equal(row[4], 'nas', 'the endpoint that still exists, and only it');
    assert.equal(row[5], '—');
  });
});

// ---------- the endpoint form ----------

describe('the endpoint form', () => {
  const form = () => doc.getElementById('endpoint-form');
  const field = (name) => form().elements.namedItem(name);

  test('the HTTP expectations follow the check type', async () => {
    await boot();
    const http = doc.getElementById('http-fields');
    assert.equal(http.style.display, 'none', 'a ping check has none');

    const type = doc.getElementById('f-type');
    type.value = 'http';
    type.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    assert.equal(http.style.display, '');

    type.value = 'icmp';
    type.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    assert.equal(http.style.display, 'none');
  });

  test('editing fills every field, retitles the form and opens it', async () => {
    await boot({
      endpoints: [endpoint({
        name: 'api', type: 'http', target: 'https://x/health', interval_seconds: 15,
        timeout_ms: 2000, down_threshold: 5, up_threshold: 1,
        expect_status: 204, expect_json: '{"ok":true}', enabled: 0
      })]
    });

    click(rowButton('endpoint-table', 'Edit'));

    assert.equal(text('#form-title'), 'Edit: api', 'this form drops the noun — it is the page\'s primary one');
    assert.equal(text('#form-submit'), 'Save changes');
    assert.equal(doc.getElementById('form-body').style.display, '', 'and the card unfolds');
    assert.equal(doc.getElementById('form-cancel').style.display, '');
    assert.equal(doc.getElementById('form-reset').style.display, 'none');

    assert.equal(field('name').value, 'api');
    assert.equal(doc.getElementById('f-type').value, 'http');
    assert.equal(field('target').value, 'https://x/health');
    assert.equal(field('interval_seconds').value, '15');
    assert.equal(field('timeout_ms').value, '2000');
    assert.equal(field('down_threshold').value, '5');
    assert.equal(field('up_threshold').value, '1');
    assert.equal(field('expect_status').value, '204');
    assert.equal(field('expect_json').value, '{"ok":true}');
    assert.equal(field('enabled').checked, false);
    assert.equal(doc.getElementById('http-fields').style.display, '', 'and the http fields come with it');
  });

  test('an endpoint with no expectations edits to empty fields, not "null"', async () => {
    await boot({ endpoints: [endpoint({ expect_status: null, expect_json: null })] });
    click(rowButton('endpoint-table', 'Edit'));

    assert.equal(field('expect_status').value, '');
    assert.equal(field('expect_json').value, '');
  });

  test('adding sends what was typed, then returns the form to add mode', async () => {
    await boot();

    field('name').value = 'ups';
    doc.getElementById('f-type').value = 'icmp';
    field('target').value = '10.0.0.9';
    field('expect_status').value = '';
    field('expect_json').value = '  ';
    submit(form());
    await settle();

    assert.deepEqual(paths('POST'), ['/api/endpoints']);
    assert.deepEqual(sent('POST'), {
      name: 'ups', type: 'icmp', target: '10.0.0.9',
      interval_seconds: 30, timeout_ms: 5000, down_threshold: 3, up_threshold: 2,
      expect_status: null, expect_json: null, enabled: true
    });
    assert.equal(text('#form-submit'), 'Add endpoint');
  });

  test('saving an edit updates that id and stays on the row', async () => {
    await boot({ endpoints: [endpoint({ id: 7 })] });
    click(rowButton('endpoint-table', 'Edit'));

    field('name').value = 'nas2';
    submit(form());
    await settle();

    assert.deepEqual(paths('PUT'), ['/api/endpoints/7']);
    assert.equal(sent('PUT').name, 'nas2');
    assert.equal(text('#form-submit'), 'Save changes', 'still editing');
    assert.equal(text('#form-save-note'), 'Saved ✓');
  });

  test('a rejected save is shown on the form rather than swallowed', async () => {
    await boot({ endpoints: [endpoint()] });
    globalThis.fetch = async (path, init) => {
      if (init?.method === 'POST' || init?.method === 'PUT') {
        return { ok: false, status: 400, json: async () => ({ error: 'target is required' }) };
      }
      return defaultFetch(path, init);
    };

    submit(form());
    await settle();
    assert.equal(text('#form-error'), 'target is required');
  });

  describe('the Test button', () => {
    const result = () => text('#form-test-result');

    test('reports a reachable endpoint with its latency', async () => {
      await boot();
      globalThis.fetch = async (path, init) => {
        calls.push({ path, method: init?.method ?? 'GET', body: null });
        if (path === '/api/endpoints/test') {
          return { ok: true, status: 200, json: async () => ({ ok: true, latencyMs: 12.4 }) };
        }
        return defaultFetch(path, init);
      };

      click(doc.getElementById('form-test'));
      await settle();

      assert.equal(result(), '✓ up (12 ms)');
      assert.equal(doc.getElementById('form-test-result').className, 'note');
    });

    test('a reachable endpoint that reported no latency is still up', async () => {
      await boot();
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, latencyMs: null }) });

      click(doc.getElementById('form-test'));
      await settle();
      assert.equal(result(), '✓ up');
    });

    test('an unreachable endpoint reports why', async () => {
      await boot();
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'timeout' }) });

      click(doc.getElementById('form-test'));
      await settle();
      assert.equal(result(), '✕ timeout');
      assert.equal(doc.getElementById('form-test-result').className, 'error');
    });

    test('a rejected test request is reported on the same line', async () => {
      await boot();
      globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'target is required' }) });

      click(doc.getElementById('form-test'));
      await settle();
      assert.equal(result(), 'target is required');
      assert.equal(doc.getElementById('form-test-result').className, 'error');
    });
  });

  describe('deleting', () => {
    test('warns that the history goes too, then deletes and re-reads', async () => {
      await boot({ endpoints: [endpoint({ id: 7 })] });

      click(rowButton('endpoint-table', 'Delete'));
      await settle();
      const dialog = doc.querySelector('.modal-overlay');
      assert.match(dialog.textContent, /Delete endpoint\?/);
      assert.match(dialog.textContent, /"nas" and all of its check history will be permanently deleted/);
      assert.match(dialog.textContent, /CANNOT be undone/);

      click(dialogButtons().confirm);
      await settle();
      assert.deepEqual(paths('DELETE'), ['/api/endpoints/7']);
      assert.equal(paths().length, 6, 'the three lists were read again afterwards');
    });

    test('backing out sends nothing', async () => {
      await boot({ endpoints: [endpoint()] });

      click(rowButton('endpoint-table', 'Delete'));
      await settle();
      click(dialogButtons().cancel);
      await settle();
      assert.deepEqual(paths('DELETE'), []);
    });

    test('deleting the row being edited drops the form out of edit mode', async () => {
      await boot({ endpoints: [endpoint({ id: 7 })] });
      click(rowButton('endpoint-table', 'Edit'));
      assert.equal(text('#form-title'), 'Edit: nas');

      data.endpoints = [];
      click(rowButton('endpoint-table', 'Delete'));
      await settle();
      click(dialogButtons().confirm);
      await settle();

      assert.equal(text('#form-title'), 'Add Flatline endpoint');
    });

    test('deleting another row leaves an edit in progress alone', async () => {
      await boot({ endpoints: [endpoint({ id: 7 }), endpoint({ id: 8, name: 'sw' })] });
      click(rowButton('endpoint-table', 'Edit')); // the first row, id 7

      data.endpoints = [endpoint({ id: 7 })];
      const deletes = [...doc.querySelectorAll('#endpoint-table tbody button')].filter((b) => b.textContent === 'Delete');
      click(deletes[1]);
      await settle();
      click(dialogButtons().confirm);
      await settle();

      assert.deepEqual(paths('DELETE'), ['/api/endpoints/8']);
      assert.equal(text('#form-title'), 'Edit: nas', 'still editing id 7');
    });
  });
});

// ---------- the group form ----------

describe('the group form', () => {
  const form = () => doc.getElementById('group-form');
  const field = (name) => form().elements.namedItem(name);
  const checks = () => [...doc.querySelectorAll('#group-endpoint-checks input[data-endpoint]')];
  const checkLabels = () => [...doc.querySelectorAll('#group-endpoint-checks label')].map((l) => l.textContent);

  test('with no endpoints, the checklist points at the form that adds one', async () => {
    await boot();
    assert.equal(checks().length, 0);
    assert.equal(text('#group-endpoint-checks'), 'Add an endpoint first (form above).');
  });

  test('every endpoint gets a box once they exist', async () => {
    await boot({ endpoints: [endpoint(), endpoint({ id: 2, name: 'sw' })] });

    assert.deepEqual(checks().map((c) => c.value), ['1', '2']);
    assert.deepEqual(checks().map((c) => c.checked), [false, false], 'a new group starts empty');
  });

  test('editing ticks the group\'s own endpoints and retitles the form', async () => {
    await boot({
      endpoints: [endpoint(), endpoint({ id: 2, name: 'sw' }), endpoint({ id: 3, name: 'ups' })],
      groups: [group({ endpoint_ids: [1, 3], mode: 'any', grace_minutes: 12, enabled: 0 })]
    });

    click(rowButton('group-table', 'Edit'));

    assert.equal(text('#group-form-title'), 'Edit group: Rack');
    assert.deepEqual(checks().map((c) => c.checked), [true, false, true]);
    assert.equal(field('name').value, 'Rack');
    assert.equal(field('mode').value, 'any');
    assert.equal(field('grace_minutes').value, '12');
    assert.equal(field('enabled').checked, false);
  });

  test('an endpoint already in another group says which, so a double-add is visible', async () => {
    await boot({
      endpoints: [endpoint({ group_ids: [1, 2], group_names: ['Rack', 'Core'] })],
      groups: [group(), group({ id: 2, name: 'Core' })]
    });

    click(rowButton('group-table', 'Edit')); // Rack, id 1
    assert.match(checkLabels()[0], /\(also in Core\)/);
    assert.doesNotMatch(checkLabels()[0], /Rack/, 'the group being edited is not "also"');
  });

  test('an endpoint in no other group carries no note', async () => {
    await boot({
      endpoints: [endpoint({ group_ids: [1], group_names: ['Rack'] })],
      groups: [group({ endpoint_ids: [1] })]
    });

    click(rowButton('group-table', 'Edit'));
    assert.equal(doc.querySelector('#group-endpoint-checks .hint'), null);
  });

  test('adding sends the ticked endpoints', async () => {
    await boot({ endpoints: [endpoint(), endpoint({ id: 2, name: 'sw' })] });

    field('name').value = 'Rack';
    field('mode').value = 'any';
    field('grace_minutes').value = '9';
    checks()[1].checked = true;
    submit(form());
    await settle();

    assert.deepEqual(paths('POST'), ['/api/groups']);
    assert.deepEqual(sent('POST'), {
      name: 'Rack', mode: 'any', grace_minutes: 9, enabled: true,
      action_group_ids: [], endpoint_ids: [2]
    });
  });

  test('an edit carries the action groups through untouched — they are assigned elsewhere', async () => {
    await boot({
      endpoints: [endpoint()],
      groups: [group({ id: 4, action_group_ids: [1, 2] })],
      actionGroups: [actionGroup(), actionGroup({ id: 2, name: 'Drain' })]
    });

    click(rowButton('group-table', 'Edit'));
    submit(form());
    await settle();

    assert.deepEqual(paths('PUT'), ['/api/groups/4']);
    assert.deepEqual(sent('PUT').action_group_ids, [1, 2],
      'the Actions page owns this assignment; the group form must not drop it');
  });

  test('leaving edit mode forgets the action groups, so the next add starts clean', async () => {
    await boot({
      endpoints: [endpoint()],
      groups: [group({ id: 4, action_group_ids: [1] })],
      actionGroups: [actionGroup()]
    });

    click(rowButton('group-table', 'Edit'));
    click(doc.getElementById('group-cancel'));

    field('name').value = 'Core';
    submit(form());
    await settle();
    assert.deepEqual(sent('POST').action_group_ids, []);
  });

  test('a refresh mid-edit leaves the ticked boxes as they are', async () => {
    await boot({ endpoints: [endpoint(), endpoint({ id: 2, name: 'sw' })] });

    checks()[0].checked = true;
    // Deleting an endpoint re-reads all three lists and re-renders — the point
    // being that renderAll must not reset a checklist someone is filling in.
    click(rowButton('endpoint-table', 'Delete'));
    await settle();
    click(dialogButtons().cancel);
    await settle();

    assert.equal(checks()[0].checked, true);
  });

  test('opening one form folds the other away, so only one edit is in progress', async () => {
    await boot({ endpoints: [endpoint()], groups: [group()] });

    click(rowButton('group-table', 'Edit'));
    assert.equal(doc.getElementById('group-form-body').style.display, '');
    assert.equal(doc.getElementById('form-body').style.display, 'none');

    click(rowButton('endpoint-table', 'Edit'));
    assert.equal(doc.getElementById('form-body').style.display, '');
    assert.equal(doc.getElementById('group-form-body').style.display, 'none');
  });

  test('deleting a group says the endpoints survive it', async () => {
    await boot({ groups: [group({ id: 4 })] });

    click(rowButton('group-table', 'Delete'));
    await settle();
    assert.match(doc.querySelector('.modal-overlay').textContent,
      /Its endpoints keep running — they just stop belonging to this group/);

    click(dialogButtons().confirm);
    await settle();
    assert.deepEqual(paths('DELETE'), ['/api/groups/4']);
  });
});

// ---------- the session snapshot ----------

describe('the session snapshot', () => {
  const KEY = 'flatline.snap.flatline';
  const snapshot = (data, ts = Date.now()) => JSON.stringify({ ts, data });

  const held = {
    groups: [group({ endpoint_ids: [1] })],
    actionGroupList: [actionGroup()],
    endpoints: [endpoint()]
  };

  /** A fetch that never answers, so only what was painted before the round trip
   *  is on the page. */
  const pending = () => new Promise(() => {});

  test('last session\'s lists are painted before the live ones arrive', async () => {
    await boot({ session: { [KEY]: snapshot(held) }, fetchImpl: pending });

    assert.equal(rows('endpoint-table')[0][1], 'nas');
    assert.equal(rows('group-table')[0][1], 'Rack');
  });

  // Nothing is drawn at all until either the snapshot or the live lists land, so
  // a rejected snapshot leaves the tables untouched — not showing their empty
  // state, which is itself a render and would claim there is nothing to show.
  test('a snapshot past its minute is ignored, rather than shown stale', async () => {
    await boot({ session: { [KEY]: snapshot(held, Date.now() - 61_000) }, fetchImpl: pending });

    assert.equal(text('#endpoint-table'), '');
    assert.equal(text('#group-table'), '');
  });

  test('an unreadable snapshot leaves the page loading as it always did', async () => {
    await boot({ session: { [KEY]: 'not json' }, fetchImpl: pending });
    assert.equal(text('#endpoint-table'), '');
  });

  test('the live lists replace what the snapshot painted', async () => {
    await boot({ session: { [KEY]: snapshot(held) }, endpoints: [endpoint({ name: 'ups' })] });
    assert.equal(rows('endpoint-table')[0][1], 'ups');
  });

  test('leaving the page saves what it is holding', async () => {
    await boot({ endpoints: [endpoint()], groups: [group()], actionGroups: [actionGroup()] });

    env.window.dispatchEvent(new env.window.Event('pagehide'));

    const saved = JSON.parse(env.window.sessionStorage.getItem(KEY));
    assert.deepEqual(saved.data.endpoints.map((e) => e.name), ['nas']);
    assert.deepEqual(saved.data.groups.map((g) => g.name), ['Rack']);
    assert.deepEqual(saved.data.actionGroupList.map((g) => g.name), ['Shutdown']);
  });

  test('a page that never finished loading saves nothing half-populated', async () => {
    const seeded = snapshot(held);
    await boot({ session: { [KEY]: seeded }, fetchImpl: pending });

    env.window.dispatchEvent(new env.window.Event('pagehide'));
    assert.equal(env.window.sessionStorage.getItem(KEY), seeded,
      'the snapshot it loaded is left as it was, rather than written back over');
  });
});
