import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDom, importFresh, click, flush } from './helpers/jsdom-env.js';

/**
 * public/scripts/dashboard.js — the landing page: outage banners, the range and
 * group-by filters, endpoint cards with their heartbeat strips and latency
 * charts, the action group / action run panel, and the event log.
 *
 * The module is a page entry point, not a library: importing it boots the page.
 * It fetches /api/dashboard, renders, arms a 1-second countdown ticker and
 * re-polls on a timer, and it exports nothing. So these tests drive it the way a
 * browser does — stand up a DOM and a fetch that answers like the server, import
 * the module, then click things and assert on what the page shows.
 *
 * node:test's mock timers stand in for the clock. That is what makes the module
 * testable at all (its poll loop reschedules itself forever, so a test process
 * would never exit), and it also turns the countdown ticker and the "poll faster
 * while a run is live" cadence into things that can be asserted directly.
 *
 * The page is the real public/index.html, as in the other three page suites:
 * jsdom parses it but does not run its `<script type="module">`, so the import
 * below is still what boots the dashboard — and any drift between the markup and
 * the ids the script reaches for shows up here as a failure. It brings the site
 * header with it, which fetches /api/version and /api/auth on every boot;
 * `paths()` drops those, since they belong to header.js and its own suite.
 *
 * Out of reach here, as in the other jsdom suites: anything that needs real
 * layout. capList() sizes the scrolling lists off getBoundingClientRect(), which
 * is all zeroes, and the chart falls back to its 600px default because
 * clientWidth is 0. The class capList adds and the chart's geometry are still
 * checked; the pixel values they compute are not.
 */

const DASH = new URL('../public/scripts/dashboard.js', import.meta.url).href;
const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const realFetch = globalThis.fetch;

let env;
let doc;
let payload;
let calls;

// ---------- payload fixtures (shapes mirror dashboardPayload in server/index.js) ----------

function endpoint(over = {}) {
  return {
    id: 1, name: 'nas', type: 'icmp', target: '10.0.0.5',
    interval_seconds: 30, group_ids: [1], group_names: ['Rack'],
    enabled: 1, state: 'up', last_change_ts: NOW - 60_000, last_check: null,
    uptime_pct: 99.5, check_count: 100,
    history: { bucketMs: 720_000, fromTs: NOW - 24 * HOUR, buckets: [] },
    recent: [],
    ...over
  };
}

function flatlineGroup(over = {}) {
  return {
    group_id: 1, name: 'Rack', mode: 'all', enabled: 1, grace_minutes: 5,
    endpoint_count: 3, down_count: 0, action_group_names: [],
    armed: false, outage_start_ts: null, deadline_ts: null,
    triggered: false, triggered_ts: null,
    ...over
  };
}

function actionGroup(over = {}) {
  return {
    id: 1, name: 'Shutdown', enabled: true, stage_count: 2,
    target_total: 3, target_up: 3, target_down: 0, target_disabled: 0,
    flatline_group_names: [], last_run: null,
    ...over
  };
}

function actionRun(over = {}) {
  return {
    id: 10, action_group_id: 1, action_group_name: 'Shutdown',
    trigger: 'manual', trigger_detail: null, status: 'running',
    stage_index: 0, stage_count: 2, steps: [],
    started_at: NOW - 30_000, estimated_end_ts: NOW + 60_000, ended_at: null,
    message: null, controllable: true, pause_requested: false, cancel_requested: false,
    ...over
  };
}

function dashboard(over = {}) {
  return {
    now: NOW, range_hours: 24, settings: {},
    groups: [], action_groups: [], action_runs: [], endpoints: [], events: [],
    ...over
  };
}

// ---------- harness ----------

/** What the shared header asks for on every page. Not the dashboard's business,
 *  but it is on the page, so something has to answer. */
const HEADER_BODIES = {
  '/api/version': { version: '1.0.0' },
  '/api/auth': { auth_required: false }
};

/**
 * Stands up the page: a DOM, a fetch answering with `data`, then the import that
 * boots it. `storage` seeds localStorage first, for the preferences the module
 * reads at import time (range, group-by, which cards are folded).
 */
async function boot(data = dashboard(), { url, storage } = {}) {
  env = setupDom(HTML, url);
  doc = env.document;
  for (const [k, v] of Object.entries(storage ?? {})) env.window.localStorage.setItem(k, v);

  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });

  payload = data;
  calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    const body = path.startsWith('/api/dashboard') ? payload : HEADER_BODIES[path] ?? {};
    return { ok: true, status: 200, json: async () => body };
  };

  await importFresh(DASH);
  await settle();
  return doc;
}

/** Lets the fetch chain and its .then/.finally callbacks run. Advances no clock,
 *  so a countdown asserted right after boot reads its exact starting value. */
const settle = () => flush(5);

/** Runs the pending requestAnimationFrame callbacks — the endpoint cards defer
 *  building their charts to one. Costs 20ms of mocked clock. */
async function frame() {
  mock.timers.tick(20);
  await settle();
}

afterEach(() => {
  mock.timers.reset();
  env.cleanup();
  globalThis.fetch = realFetch;
});

/** The requests the dashboard made, less the two the shared header always makes. */
const paths = (method = 'GET') => calls
  .filter((c) => c.method === method && !(c.path in HEADER_BODIES))
  .map((c) => c.path);

/** The buttons in the dialog confirmDialog()/alertDialog() puts on the page. */
function dialogButtons() {
  const buttons = [...doc.querySelectorAll('.modal-overlay .modal-actions button')];
  // showDialog appends cancel then confirm; an alert has confirm only.
  return buttons.length > 1 ? { cancel: buttons[0], confirm: buttons[1] } : { cancel: null, confirm: buttons[0] };
}

const text = (sel, root = doc) => root.querySelector(sel)?.textContent ?? null;

// ---------- boot ----------

describe('boot', () => {
  test('fetches the dashboard for the stored range and renders every region', async () => {
    await boot(dashboard(), { storage: { 'flatline.range': '6' } });

    assert.deepEqual(paths(), ['/api/dashboard?hours=6']);
    assert.match(text('#filters'), /No endpoints configured/);
    assert.match(text('#endpoints'), /No endpoints yet/);
    assert.match(text('#action-panel'), /Action groups/);
    assert.match(text('#events'), /Recent events/);
  });

  test('a stored range that is no longer offered falls back to 24h', async () => {
    await boot(dashboard(), { storage: { 'flatline.range': '999' } });
    assert.deepEqual(paths(), ['/api/dashboard?hours=24']);
  });
});

// ---------- banners ----------

describe('banners', () => {
  test('an armed group gets a warning banner, a countdown and the actions it will run', async () => {
    await boot(dashboard({
      groups: [flatlineGroup({
        armed: true, deadline_ts: NOW + 125_000, down_count: 2,
        action_group_names: ['Shutdown', 'Drain']
      })]
    }));

    const banner = doc.querySelector('#banners .banner');
    assert.match(banner.className, /\barmed\b/);
    assert.match(banner.textContent, /Group "Rack" failed \(2\/3 down\) — will run: Shutdown, Drain\./);
    assert.equal(text('.countdown', banner), '2:05');
  });

  test('a group with nothing assigned says so rather than trailing off', async () => {
    await boot(dashboard({ groups: [flatlineGroup({ armed: true, deadline_ts: NOW + 60_000 })] }));
    assert.match(text('#banners .banner'), /no action groups assigned/);
  });

  test('a triggered group replaces the countdown with the time it fired', async () => {
    await boot(dashboard({
      groups: [flatlineGroup({
        armed: true, triggered: true, triggered_ts: NOW, action_group_names: ['Shutdown']
      })]
    }));

    const banner = doc.querySelector('#banners .banner');
    assert.match(banner.className, /\btriggered\b/);
    assert.match(banner.textContent, /"Rack" TRIGGERED — running action group\(s\): Shutdown\./);
    assert.notEqual(text('.countdown', banner), '');
  });

  test('a group that is not armed gets no banner', async () => {
    await boot(dashboard({ groups: [flatlineGroup({ down_count: 1 })] }));
    assert.equal(doc.querySelector('#banners .banner'), null);
  });

  test('the countdown ticks down once a second without re-fetching', async () => {
    await boot(dashboard({ groups: [flatlineGroup({ armed: true, deadline_ts: NOW + 125_000 })] }));
    assert.equal(text('#banners .countdown'), '2:05');

    mock.timers.tick(1000);
    assert.equal(text('#banners .countdown'), '2:04');
    assert.equal(paths().length, 1, 'the ticker redraws the text, it does not poll');
  });

  test('a countdown past its deadline floors at zero', async () => {
    await boot(dashboard({ groups: [flatlineGroup({ armed: true, deadline_ts: NOW - 5000 })] }));
    assert.equal(text('#banners .countdown'), '0:00');
  });

  test('dismissing a banner hides it, and a later poll leaves it hidden', async () => {
    await boot(dashboard({ groups: [flatlineGroup({ armed: true, deadline_ts: NOW + 60_000 })] }));

    click(doc.querySelector('#banners .banner-x'));
    assert.equal(doc.querySelector('#banners .banner'), null);

    mock.timers.tick(10_000);
    await settle();
    assert.equal(paths().length, 2, 'the poll ran');
    assert.equal(doc.querySelector('#banners .banner'), null, 'and did not bring it back');
  });

  test('a dismissed countdown does not swallow the TRIGGERED notice that follows', async () => {
    await boot(dashboard({ groups: [flatlineGroup({ armed: true, deadline_ts: NOW + 60_000 })] }));
    click(doc.querySelector('#banners .banner-x'));

    payload = dashboard({ groups: [flatlineGroup({ armed: true, triggered: true, triggered_ts: NOW })] });
    mock.timers.tick(10_000);
    await settle();

    assert.match(text('#banners .banner'), /TRIGGERED/);
  });

  test('the dismissal is forgotten once the group recovers, so the next outage says so', async () => {
    await boot(dashboard({ groups: [flatlineGroup({ armed: true, deadline_ts: NOW + 60_000 })] }));
    click(doc.querySelector('#banners .banner-x'));

    payload = dashboard({ groups: [flatlineGroup()] }); // recovered — no banner either way
    mock.timers.tick(10_000);
    await settle();
    assert.equal(doc.querySelector('#banners .banner'), null);

    payload = dashboard({ groups: [flatlineGroup({ armed: true, deadline_ts: NOW + 60_000 })] });
    mock.timers.tick(10_000);
    await settle();
    assert.ok(doc.querySelector('#banners .banner'), 'the new outage is announced again');
  });
});

// ---------- filters ----------

describe('filters', () => {
  const ranges = () => [...doc.querySelectorAll('.range-btn')].map((b) => b.textContent);

  test('offers every range and marks the active one', async () => {
    await boot();
    assert.deepEqual(ranges(), ['1h', '6h', '24h', '7d', '14d']);
    assert.equal(doc.querySelector('.range-btn.active').textContent, '24h');
  });

  test('picking a range re-fetches at that range and remembers it', async () => {
    await boot();
    click([...doc.querySelectorAll('.range-btn')].find((b) => b.textContent === '7d'));
    await settle();

    assert.deepEqual(paths(), ['/api/dashboard?hours=24', '/api/dashboard?hours=168']);
    assert.equal(env.window.localStorage.getItem('flatline.range'), '168');
    assert.equal(doc.querySelector('.range-btn.active').textContent, '7d');
  });

  test('changing the grouping re-renders from the data already held, and remembers it', async () => {
    await boot(dashboard({ endpoints: [endpoint()] }));

    const select = doc.querySelector('.groupby-select');
    assert.equal(select.value, 'group', 'grouping by Flatline group is the default');

    select.value = 'type';
    select.dispatchEvent(new env.window.Event('change', { bubbles: true }));
    await settle();

    assert.equal(paths().length, 1, 're-rendered without re-fetching');
    assert.equal(env.window.localStorage.getItem('flatline.groupBy'), 'type');
    assert.equal(text('.gh-title'), 'Ping (ICMP)');
  });

  test('?groupby in the URL beats the remembered choice, so a grouped view is linkable', async () => {
    await boot(dashboard({ endpoints: [endpoint()] }), {
      url: 'http://localhost/?groupby=none',
      storage: { 'flatline.groupBy': 'group' }
    });

    assert.equal(doc.querySelector('.groupby-select').value, 'none');
    assert.equal(doc.querySelector('.group-heading'), null);
  });

  test('an unrecognised ?groupby is ignored in favour of the remembered choice', async () => {
    await boot(dashboard({ endpoints: [endpoint()] }), {
      url: 'http://localhost/?groupby=bogus',
      storage: { 'flatline.groupBy': 'type' }
    });
    assert.equal(doc.querySelector('.groupby-select').value, 'type');
  });

  describe('the summary counts only endpoints that are being checked', () => {
    const summary = () => text('#filters .summary');

    test('none configured', async () => {
      await boot();
      assert.equal(summary(), 'No endpoints configured');
    });

    test('all up', async () => {
      await boot(dashboard({ endpoints: [endpoint(), endpoint({ id: 2, name: 'sw' })] }));
      assert.equal(summary(), 'All 2 endpoints up');
    });

    test('some down', async () => {
      await boot(dashboard({
        endpoints: [endpoint(), endpoint({ id: 2, name: 'sw', state: 'down' })]
      }));
      assert.equal(summary(), '1 of 2 endpoints DOWN');
    });

    test('a paused endpoint counts towards neither total', async () => {
      await boot(dashboard({
        endpoints: [endpoint(), endpoint({ id: 2, name: 'sw', enabled: 0, state: 'down' })]
      }));
      assert.equal(summary(), 'All 1 endpoints up');
    });
  });
});

// ---------- endpoint cards ----------

describe('endpoint cards', () => {
  test('the empty state points at the page that fills it', async () => {
    await boot();
    const empty = doc.querySelector('#endpoints .empty');
    assert.equal(text('.big', empty), 'No endpoints yet');
    assert.equal(empty.querySelector('a').getAttribute('href'), '/flatline');
  });

  test('a card carries the state pill, name, target and its group badges', async () => {
    await boot(dashboard({
      endpoints: [endpoint({ group_names: ['Rack', 'Core'] })]
    }), { storage: { 'flatline.groupBy': 'none' } });

    const card = doc.querySelector('.endpoint-card');
    assert.equal(text('.pill', card), 'UP');
    assert.equal(text('.name', card), 'nas');
    assert.equal(text('.target', card), 'ping · 10.0.0.5');
    assert.deepEqual([...card.querySelectorAll('.badge')].map((b) => b.textContent), ['⛓ Rack', '⛓ Core']);
    assert.equal(text('.uptime .value', card), '99.50%');
  });

  test('the pill reads PAUSED for a disabled endpoint, whatever its last state was', async () => {
    await boot(dashboard({ endpoints: [endpoint({ enabled: 0, state: 'down' })] }),
      { storage: { 'flatline.groupBy': 'none' } });
    assert.equal(text('.endpoint-card .pill'), 'PAUSED');
  });

  test('an endpoint with no state yet reads PENDING', async () => {
    await boot(dashboard({ endpoints: [endpoint({ state: null, uptime_pct: null })] }),
      { storage: { 'flatline.groupBy': 'none' } });
    assert.equal(text('.endpoint-card .pill'), 'PENDING');
    assert.equal(text('.endpoint-card .uptime .value'), '—');
  });

  test('an http endpoint is labelled http', async () => {
    await boot(dashboard({ endpoints: [endpoint({ type: 'http', target: 'https://x/health' })] }),
      { storage: { 'flatline.groupBy': 'none' } });
    assert.equal(text('.endpoint-card .target'), 'http · https://x/health');
  });

  describe('grouping', () => {
    const headings = () => [...doc.querySelectorAll('.gh-title')].map((h) => h.textContent);

    test('by Flatline group, and an endpoint in two groups appears under both', async () => {
      await boot(dashboard({
        endpoints: [endpoint({ group_names: ['Rack', 'Core'] }), endpoint({ id: 2, name: 'sw', group_names: ['Rack'] })]
      }));

      assert.deepEqual(headings(), ['Rack', 'Core']);
      const sections = doc.querySelectorAll('.group-section');
      assert.equal(sections[0].querySelectorAll('.endpoint-card').length, 2, 'Rack holds both');
      assert.equal(sections[1].querySelectorAll('.endpoint-card').length, 1, 'Core holds nas only');
    });

    test('an endpoint in no group gets a bucket of its own', async () => {
      await boot(dashboard({ endpoints: [endpoint({ group_names: [] })] }));
      assert.deepEqual(headings(), ['No group']);
    });

    test('by check type', async () => {
      await boot(dashboard({
        endpoints: [endpoint(), endpoint({ id: 2, name: 'api', type: 'http', target: 'https://x' })]
      }), { storage: { 'flatline.groupBy': 'type' } });
      assert.deepEqual(headings(), ['Ping (ICMP)', 'HTTP(S)']);
    });

    test('the heading counts the section, and calls out how many are down', async () => {
      await boot(dashboard({
        endpoints: [endpoint(), endpoint({ id: 2, name: 'sw', state: 'down' })]
      }));
      assert.equal(text('.gh-count'), '2 endpoints · 1 down');
    });

    test('with none down the heading is just the count', async () => {
      await boot(dashboard({ endpoints: [endpoint()] }));
      assert.equal(text('.gh-count'), '1 endpoints');
    });

    test('folding a section hides it and is remembered', async () => {
      await boot(dashboard({ endpoints: [endpoint()] }));
      const heading = doc.querySelector('.group-heading');
      assert.equal(heading.getAttribute('aria-expanded'), 'true');

      click(heading);
      assert.equal(heading.getAttribute('aria-expanded'), 'false');
      assert.equal(doc.querySelector('.group-section').style.display, 'none');
      assert.deepEqual(
        JSON.parse(env.window.localStorage.getItem('flatline.collapsedSections')),
        ['group:Rack']
      );
    });

    test('a section that starts folded builds no cards until it is opened', async () => {
      await boot(dashboard({ endpoints: [endpoint()] }),
        { storage: { 'flatline.collapsedSections': '["group:Rack"]' } });

      const body = doc.querySelector('.group-section');
      assert.equal(body.style.display, 'none');
      assert.equal(body.querySelectorAll('.endpoint-card').length, 0, 'nothing built while hidden');

      click(doc.querySelector('.group-heading'));
      assert.equal(body.style.display, '');
      assert.equal(body.querySelectorAll('.endpoint-card').length, 1, 'built on first reveal');
    });

    test('each grouping mode remembers its own folds', async () => {
      await boot(dashboard({ endpoints: [endpoint()] }),
        { storage: { 'flatline.collapsedSections': '["type:Ping (ICMP)"]' } });
      assert.equal(doc.querySelector('.group-section').style.display, '',
        'a fold recorded under "type" leaves the "group" view open');
    });
  });
});

// ---------- heartbeat strip ----------

describe('heartbeat strip', () => {
  const recent = [
    { ts: NOW - 2000, ok: 1, latency_ms: 12.5, error: null },
    { ts: NOW - 1000, ok: 0, latency_ms: null, error: 'timeout' },
    { ts: NOW, ok: 1, latency_ms: 9, error: null }
  ];

  test('one cell per recent check, marked ok or fail', async () => {
    await boot(dashboard({ endpoints: [endpoint({ recent })] }),
      { storage: { 'flatline.groupBy': 'none' } });

    const beats = [...doc.querySelectorAll('.beat')];
    assert.equal(beats.length, 3);
    assert.deepEqual(beats.map((b) => b.className), ['beat ok', 'beat fail', 'beat ok']);
  });

  test('each cell carries the check it stands for, which is what the tooltip reads', async () => {
    await boot(dashboard({ endpoints: [endpoint({ recent })] }),
      { storage: { 'flatline.groupBy': 'none' } });

    const [ok, fail] = doc.querySelectorAll('.beat');
    assert.deepEqual({ ...ok.dataset }, { ts: String(NOW - 2000), ok: '1', lat: '12.5', err: '' });
    assert.deepEqual({ ...fail.dataset }, { ts: String(NOW - 1000), ok: '0', lat: '', err: 'timeout' });
  });

  test('the strip is labelled, and captioned to separate it from the range selector', async () => {
    await boot(dashboard({ endpoints: [endpoint({ recent })] }),
      { storage: { 'flatline.groupBy': 'none' } });

    assert.equal(doc.querySelector('.beats').getAttribute('aria-label'), 'Last 3 checks for nas');
    assert.equal(text('.beats-caption'), 'last 3 checks');
  });
});

// ---------- latency chart ----------

describe('latency chart', () => {
  // 24h over 720s buckets is the 120-bucket timeline the server sends.
  const history = (buckets) => ({ bucketMs: 720_000, fromTs: NOW - 24 * HOUR, buckets });

  test('an endpoint with no history says it is still collecting', async () => {
    await boot(dashboard({ endpoints: [endpoint()] }), { storage: { 'flatline.groupBy': 'none' } });
    assert.equal(doc.querySelector('.chart-wrap svg'), null, 'nothing drawn before the frame runs');

    await frame();
    assert.equal(text('.chart-wrap'), 'Collecting data…');
  });

  test('history draws a chart once the frame runs', async () => {
    await boot(dashboard({
      endpoints: [endpoint({ history: history([{ bucket: 0, total: 4, ok_count: 4, avg_latency: 12 }]) })]
    }), { storage: { 'flatline.groupBy': 'none' } });
    await frame();

    const chart = doc.querySelector('.chart-wrap svg');
    assert.ok(chart);
    // jsdom lays nothing out, so clientWidth is 0 and the 600px default applies.
    assert.equal(chart.getAttribute('viewBox'), '0 0 600 130');
  });

  test('failed buckets are washed over, more strongly when nothing got through', async () => {
    await boot(dashboard({
      endpoints: [endpoint({ history: history([
        { bucket: 0, total: 4, ok_count: 4, avg_latency: 12 },
        { bucket: 1, total: 4, ok_count: 0, avg_latency: null },
        { bucket: 2, total: 4, ok_count: 2, avg_latency: 30 }
      ]) })]
    }), { storage: { 'flatline.groupBy': 'none' } });
    await frame();

    const bands = [...doc.querySelectorAll('.chart-wrap rect')]
      .filter((r) => r.getAttribute('style').includes('--status-critical'));
    assert.equal(bands.length, 2, 'the fully-ok bucket gets no band');
    assert.match(bands[0].getAttribute('style'), /opacity:0\.2\b/, 'nothing up — the stronger wash');
    assert.match(bands[1].getAttribute('style'), /opacity:0\.08\b/, 'partly up — the lighter one');
  });

  test('the line breaks across gaps rather than bridging them', async () => {
    await boot(dashboard({
      endpoints: [endpoint({ history: history([
        { bucket: 0, total: 4, ok_count: 4, avg_latency: 12 },
        { bucket: 1, total: 4, ok_count: 4, avg_latency: 14 },
        // buckets 2-3 have no checks at all — a gap, not a zero
        { bucket: 4, total: 4, ok_count: 4, avg_latency: 20 },
        { bucket: 5, total: 4, ok_count: 4, avg_latency: 22 }
      ]) })]
    }), { storage: { 'flatline.groupBy': 'none' } });
    await frame();

    const lines = [...doc.querySelectorAll('.chart-wrap path')]
      .filter((p) => p.getAttribute('style').includes('stroke:var(--series-1)'));
    assert.equal(lines.length, 2, 'two segments, not one line through the gap');
  });

  test('a lone reading is drawn as a point, since a line needs two', async () => {
    await boot(dashboard({
      endpoints: [endpoint({ history: history([{ bucket: 0, total: 4, ok_count: 4, avg_latency: 12 }]) })]
    }), { storage: { 'flatline.groupBy': 'none' } });
    await frame();

    assert.equal(doc.querySelectorAll('.chart-wrap circle').length, 1);
    assert.equal(
      [...doc.querySelectorAll('.chart-wrap path')].filter((p) => p.getAttribute('style').includes('stroke:var(--series-1)')).length,
      0
    );
  });
});

// ---------- action groups ----------

describe('action groups', () => {
  test('the empty state points at the page that builds one', async () => {
    await boot();
    const empty = doc.querySelector('#action-panel .empty');
    assert.match(empty.textContent, /No action groups yet/);
    assert.equal(empty.querySelector('a').getAttribute('href'), '/actions');
  });

  test('a row shows the switch, the stage count, the target tally and when it last ran', async () => {
    await boot(dashboard({
      action_groups: [actionGroup({
        target_up: 1, target_down: 1, target_disabled: 1,
        flatline_group_names: ['Rack'],
        last_run: { status: 'completed', started_at: NOW - HOUR }
      })]
    }));

    const row = doc.querySelector('.ag-row');
    assert.equal(text('.pill', row), 'ENABLED');
    assert.equal(text('.ag-name', row), 'Shutdown');
    assert.match(row.textContent, /2 stages/);
    assert.match(row.textContent, /1\/3 targets up · 1 down · 1 disabled/);
    assert.match(row.textContent, /last run .* \(completed\)/);
    assert.equal(text('.ag-badge', row), '⛓ Rack');
  });

  test('a single stage is not pluralised, and a clean tally is not padded', async () => {
    await boot(dashboard({ action_groups: [actionGroup({ stage_count: 1 })] }));
    const meta = doc.querySelectorAll('.ag-row .ag-meta span');
    assert.equal(meta[0].textContent, '1 stage');
    assert.equal(meta[1].textContent, '3/3 targets up', 'no "0 down"/"0 disabled" padding');
  });

  test('a group never run, and not wired to a Flatline group, says both', async () => {
    await boot(dashboard({ action_groups: [actionGroup()] }));
    const row = doc.querySelector('.ag-row');
    assert.match(row.textContent, /never run/);
    assert.match(row.textContent, /not assigned to a Flatline group/);
  });

  describe('Run now', () => {
    const runBtn = () => doc.querySelector('.ag-row .btn.danger-soft');

    test('is disabled, with a reason, while that group is already running', async () => {
      await boot(dashboard({
        action_groups: [actionGroup()],
        action_runs: [actionRun({ status: 'running' })]
      }));
      assert.equal(runBtn().disabled, true);
      assert.equal(runBtn().getAttribute('title'), 'This action group is already running');
    });

    test('is disabled, with a reason, for a group with no targets', async () => {
      await boot(dashboard({ action_groups: [actionGroup({ target_total: 0, target_up: 0 })] }));
      assert.equal(runBtn().disabled, true);
      assert.equal(runBtn().getAttribute('title'), 'This action group has no targets yet');
    });

    test('a paused run still counts as running', async () => {
      await boot(dashboard({
        action_groups: [actionGroup()],
        action_runs: [actionRun({ status: 'paused' })]
      }));
      assert.equal(runBtn().disabled, true);
    });

    test('a finished run does not block the next one', async () => {
      await boot(dashboard({
        action_groups: [actionGroup()],
        action_runs: [actionRun({ status: 'completed', ended_at: NOW })]
      }));
      assert.equal(runBtn().disabled, false);
    });

    test('warns that this cannot be undone, and starts the run once confirmed', async () => {
      await boot(dashboard({ action_groups: [actionGroup()] }));

      click(runBtn());
      await settle();
      const dialog = doc.querySelector('.modal-overlay');
      assert.match(dialog.textContent, /Run this action group now\?/);
      assert.match(dialog.textContent, /all 2 stage\(s\) of "Shutdown"/);
      assert.match(dialog.textContent, /CANNOT be undone/);

      click(dialogButtons().confirm);
      await settle();
      assert.deepEqual(paths('POST'), ['/api/actions/groups/1/run']);
      assert.equal(paths().length, 2, 'and the page re-reads its state afterwards');
    });

    test('backing out of the dialog sends nothing', async () => {
      await boot(dashboard({ action_groups: [actionGroup()] }));

      click(runBtn());
      await settle();
      click(dialogButtons().cancel);
      await settle();

      assert.deepEqual(paths('POST'), []);
      assert.equal(runBtn().disabled, false, 'the button is left usable');
    });

    test('a rejected start is reported rather than swallowed', async () => {
      await boot(dashboard({ action_groups: [actionGroup()] }));
      globalThis.fetch = async (path, init) => {
        calls.push({ path, method: init?.method ?? 'GET' });
        if (init?.method === 'POST') {
          return { ok: false, status: 409, json: async () => ({ error: 'already running' }) };
        }
        return { ok: true, status: 200, json: async () => payload };
      };

      click(runBtn());
      await settle();
      click(dialogButtons().confirm);
      await settle();

      const dialog = doc.querySelector('.modal-overlay');
      assert.match(dialog.textContent, /Could not start the run/);
      assert.match(dialog.textContent, /already running/);
    });
  });

  test('the panel folds as one row, and is remembered', async () => {
    await boot(dashboard({ action_groups: [actionGroup()] }));
    assert.equal(doc.querySelectorAll('#action-panel .card-body').length, 2);

    click(doc.querySelector('#action-panel .card-header'));
    assert.equal(env.window.localStorage.getItem('flatline.actionPanelCollapsed'), '1');
    assert.equal(doc.querySelectorAll('#action-panel .card-body').length, 0,
      'clicking either header folds both halves');
  });

  test('a folded panel comes back folded', async () => {
    await boot(dashboard({ action_groups: [actionGroup()] }),
      { storage: { 'flatline.actionPanelCollapsed': '1' } });
    assert.equal(doc.querySelectorAll('#action-panel .card-body').length, 0);
    assert.equal(doc.querySelector('#action-panel .card-header').getAttribute('aria-expanded'), 'false');
  });
});

// ---------- action runs ----------

describe('action runs', () => {
  const runList = () => doc.querySelector('.row-list[data-list="runs"]');

  test('with nothing ever run, the panel explains when runs appear', async () => {
    await boot();
    assert.match(text('#action-panel'), /Nothing has run yet/);
  });

  test('a live run shows its status, group and stage', async () => {
    await boot(dashboard({ action_runs: [actionRun({ stage_index: 1, stage_count: 3 })] }));

    const row = doc.querySelector('.run-row');
    assert.equal(text('.pill', row), 'RUNNING');
    assert.equal(text('.run-name', row), 'Shutdown');
    assert.equal(text('.run-stage', row), 'stage 2 of 3');
    assert.match(row.textContent, /started .* · done by .* at the latest/);
    assert.match(row.textContent, /started manually/);
  });

  test('the stage number never runs past the count once the last one finishes', async () => {
    await boot(dashboard({ action_runs: [actionRun({ stage_index: 2, stage_count: 2 })] }));
    assert.equal(text('.run-stage'), 'stage 2 of 2');
  });

  test('a group with no stages says so instead of showing "stage 1 of 0"', async () => {
    await boot(dashboard({ action_runs: [actionRun({ stage_count: 0 })] }));
    assert.equal(text('.run-stage'), 'no stages');
  });

  test('a triggered run names what triggered it', async () => {
    await boot(dashboard({
      action_runs: [actionRun({ trigger: 'flatline', trigger_detail: 'Rack' })]
    }));
    assert.match(text('.run-meta'), /triggered by "Rack"/);
  });

  test('every step of the stage is shown, each with its own mark', async () => {
    await boot(dashboard({
      action_runs: [actionRun({ steps: [
        { name: 'nas', state: 'ok' }, { name: 'esx1', state: 'running' },
        { name: 'esx2', state: 'pending' }, { name: 'old', state: 'skipped' },
        { name: 'nvr', state: 'failed' }
      ] })]
    }));

    assert.deepEqual(
      [...doc.querySelectorAll('.run-step')].map((s) => s.textContent),
      ['✓ nas', '⋯ esx1', '· esx2', '⊘ old', '✕ nvr']
    );
  });

  test('with nothing live, the panel falls back to recent history and says so', async () => {
    await boot(dashboard({
      action_runs: Array.from({ length: 7 }, (_, i) => actionRun({
        id: 100 + i, status: 'completed', ended_at: NOW - i * HOUR, controllable: false
      }))
    }));

    assert.match(text('.run-caption'), /Nothing running right now — most recent runs:/);
    assert.equal(runList().children.length, 5, 'the five most recent');
    assert.match(text('.run-row .run-meta'), /→/, 'a finished run reads start → end');
  });

  test('once something is live, only the live runs are listed', async () => {
    await boot(dashboard({
      action_runs: [actionRun({ id: 1, status: 'running' }), actionRun({ id: 2, status: 'completed', ended_at: NOW })]
    }));
    assert.equal(doc.querySelector('.run-caption'), null);
    assert.equal(runList().children.length, 1);
  });

  test('an unknown status still renders, rather than blanking the row', async () => {
    await boot(dashboard({ action_runs: [actionRun({ status: 'weird', ended_at: NOW })] }));
    assert.equal(text('.run-row .pill'), 'WEIRD');
  });

  test('a run that ended with a message shows it', async () => {
    await boot(dashboard({
      action_runs: [actionRun({ status: 'failed', ended_at: NOW, controllable: false, message: 'ssh: no route to host' })]
    }));
    assert.equal(text('.run-message'), 'ssh: no route to host');
    assert.equal(text('.run-row .pill'), 'FAILED');
  });

  describe('controls', () => {
    const buttons = () => [...doc.querySelectorAll('.run-btns button')];

    test('a finished run has none', async () => {
      await boot(dashboard({ action_runs: [actionRun({ status: 'completed', ended_at: NOW })] }));
      assert.equal(doc.querySelector('.run-btns'), null);
    });

    test('pausing sends the pause and re-reads the state', async () => {
      await boot(dashboard({ action_runs: [actionRun()] }));
      const [pause] = buttons();
      assert.equal(pause.textContent, 'Pause');

      click(pause);
      await settle();
      assert.deepEqual(paths('POST'), ['/api/actions/runs/10/pause']);
      assert.equal(paths().length, 2);
    });

    test('a paused run offers Resume instead', async () => {
      await boot(dashboard({ action_runs: [actionRun({ status: 'paused' })] }));
      const [resume] = buttons();
      assert.equal(resume.textContent, 'Resume');

      click(resume);
      await settle();
      assert.deepEqual(paths('POST'), ['/api/actions/runs/10/resume']);
    });

    test('cancelling warns what it will and will not undo, then sends it', async () => {
      await boot(dashboard({ action_runs: [actionRun()] }));

      click(buttons()[1]);
      await settle();
      const dialog = doc.querySelector('.modal-overlay');
      assert.match(dialog.textContent, /"Shutdown" will stop before its next stage/);
      assert.match(dialog.textContent, /NOT undone/);
      assert.match(dialog.textContent, /cannot be recalled/);

      click(dialogButtons().confirm);
      await settle();
      assert.deepEqual(paths('POST'), ['/api/actions/runs/10/cancel']);
    });

    test('backing out of the cancel dialog sends nothing', async () => {
      await boot(dashboard({ action_runs: [actionRun()] }));
      click(buttons()[1]);
      await settle();
      click(dialogButtons().cancel);
      await settle();
      assert.deepEqual(paths('POST'), []);
    });

    test('a run the server can no longer reach is not offered controls it cannot honour', async () => {
      await boot(dashboard({ action_runs: [actionRun({ controllable: false })] }));
      assert.deepEqual(buttons().map((b) => b.disabled), [true, true]);
      assert.equal(text('.run-note'), 'this run is no longer controllable');
    });

    test('a cancel already asked for locks both buttons and says it is pending', async () => {
      await boot(dashboard({ action_runs: [actionRun({ cancel_requested: true })] }));
      assert.deepEqual(buttons().map((b) => b.disabled), [true, true]);
      assert.equal(text('.run-note'), 'cancelling after the current stage…');
    });

    test('a pause already asked for says it is pending, without locking the row', async () => {
      await boot(dashboard({ action_runs: [actionRun({ pause_requested: true })] }));
      assert.equal(text('.run-note'), 'pausing after the current stage…');
      assert.deepEqual(buttons().map((b) => b.disabled), [false, false]);
    });

    test('a rejected control is reported rather than swallowed', async () => {
      await boot(dashboard({ action_runs: [actionRun()] }));
      globalThis.fetch = async (path, init) => {
        calls.push({ path, method: init?.method ?? 'GET' });
        if (init?.method === 'POST') return { ok: false, status: 409, json: async () => ({ error: 'run already finished' }) };
        return { ok: true, status: 200, json: async () => payload };
      };

      click(buttons()[0]);
      await settle();
      const dialog = doc.querySelector('.modal-overlay');
      assert.match(dialog.textContent, /Could not change the run/);
      assert.match(dialog.textContent, /run already finished/);
    });
  });
});

// ---------- events ----------

describe('events', () => {
  const event = (over) => ({ ts: NOW, kind: 'state', endpoint_name: null, message: null, ...over });

  test('the empty state explains what will land here', async () => {
    await boot();
    assert.match(text('#events .empty'), /No events yet/);
  });

  test('each kind gets its own label and up/down colouring', async () => {
    await boot(dashboard({ events: [
      event({ kind: 'state', to_state: 'up' }),
      event({ kind: 'state', to_state: 'down' }),
      event({ kind: 'shutdown_armed' }),
      event({ kind: 'shutdown_disarmed' }),
      event({ kind: 'shutdown_triggered' }),
      event({ kind: 'action_run_started' }),
      event({ kind: 'action_run_completed' }),
      event({ kind: 'action_run_failed' }),
      event({ kind: 'action_step_ok' }),
      event({ kind: 'action_step_failed' }),
      event({ kind: 'action_step_skipped' })
    ] }));

    assert.deepEqual([...doc.querySelectorAll('#events .what')].map((n) => n.textContent), [
      '▲ UP', '▼ DOWN', '⚠ countdown armed', '✓ countdown disarmed', '⛔ ACTIONS TRIGGERED',
      '▶ run started', '■ run completed', '■ run failed', '✓ step ok', '✕ step failed', '⊘ step skipped'
    ]);
    assert.deepEqual([...doc.querySelectorAll('#events .what')].map((n) => n.className), [
      'what to-up', 'what to-down', 'what to-down', 'what to-up', 'what to-down',
      'what to-down', 'what to-up', 'what to-down', 'what to-up', 'what to-down', 'what '
    ]);
  });

  test('an unrecognised kind is shown as-is rather than dropped', async () => {
    await boot(dashboard({ events: [event({ kind: 'something_new' })] }));
    assert.equal(text('#events .what'), 'something_new');
  });

  test('a row carries the endpoint and message when there are any', async () => {
    await boot(dashboard({ events: [
      event({ kind: 'state', to_state: 'down', endpoint_name: 'nas', message: 'timeout' }),
      event({ kind: 'shutdown_armed' })
    ] }));

    const [withDetail, without] = doc.querySelectorAll('.event-row');
    assert.match(withDetail.textContent, /nas/);
    assert.equal(text('.msg', withDetail), 'timeout');
    assert.equal(without.querySelector('.msg'), null);
    assert.equal(without.childNodes.length, 2, 'time and label only');
  });

  test('the card folds, and is remembered', async () => {
    await boot(dashboard({ events: [event({ kind: 'shutdown_armed' })] }));
    assert.ok(doc.querySelector('#events .card-body'));

    click(doc.querySelector('#events .card-header'));
    assert.equal(env.window.localStorage.getItem('flatline.eventsCollapsed'), '1');
    assert.equal(doc.querySelector('#events .card-body'), null);
  });

  test('a folded card comes back folded', async () => {
    await boot(dashboard({ events: [event({ kind: 'shutdown_armed' })] }),
      { storage: { 'flatline.eventsCollapsed': '1' } });
    assert.equal(doc.querySelector('#events .card-body'), null);
  });
});

// ---------- long lists ----------

describe('long lists scroll rather than stretching the page', () => {
  // capList measures the rows to place the cap, so the height it sets is
  // meaningless under jsdom. That it switches the list to scrolling is not.
  test('a run list within the cap is left alone', async () => {
    await boot(dashboard({
      action_runs: Array.from({ length: 3 }, (_, i) => actionRun({ id: i, status: 'running' }))
    }));
    assert.equal(doc.querySelector('.row-list[data-list="runs"]').className, 'row-list');
  });

  test('a run list over the cap starts scrolling', async () => {
    await boot(dashboard({
      action_runs: Array.from({ length: 4 }, (_, i) => actionRun({ id: i, status: 'running' }))
    }));
    assert.match(doc.querySelector('.row-list[data-list="runs"]').className, /\bscroll-list\b/);
  });

  test('the event log has a cap of its own', async () => {
    await boot(dashboard({
      events: Array.from({ length: 9 }, () => ({ ts: NOW, kind: 'shutdown_armed', endpoint_name: null, message: null }))
    }));
    assert.match(doc.querySelector('#events .row-list').className, /\bscroll-list\b/);
  });
});

// ---------- polling ----------

describe('polling', () => {
  test('idles at ten seconds', async () => {
    await boot();
    assert.equal(paths().length, 1);

    mock.timers.tick(9_999);
    await settle();
    assert.equal(paths().length, 1);

    mock.timers.tick(1);
    await settle();
    assert.equal(paths().length, 2);
  });

  test('speeds up to three seconds while a run is live, and settles once it ends', async () => {
    await boot(dashboard({ action_runs: [actionRun({ status: 'running' })] }));

    mock.timers.tick(3000);
    await settle();
    assert.equal(paths().length, 2, 'a live run is polled at the faster rate');

    payload = dashboard({ action_runs: [actionRun({ status: 'completed', ended_at: NOW, controllable: false })] });
    mock.timers.tick(3000);
    await settle();
    assert.equal(paths().length, 3, 'still fast — the run was live when this poll was scheduled');

    mock.timers.tick(3000);
    await settle();
    assert.equal(paths().length, 3, 'back to the idle rate');

    mock.timers.tick(7000);
    await settle();
    assert.equal(paths().length, 4);
  });

  test('a failed poll leaves the page as it was and keeps polling', async () => {
    await boot(dashboard({ endpoints: [endpoint()] }));
    assert.equal(doc.querySelectorAll('.endpoint-card').length, 1);

    globalThis.fetch = async (path, init) => {
      calls.push({ path, method: init?.method ?? 'GET' });
      throw new Error('network down');
    };
    // refresh() logs the failure it swallows; expected here, so keep it out of
    // the run's output rather than have two stack traces look like a problem.
    const realError = console.error;
    console.error = () => {};
    try {
      mock.timers.tick(10_000);
      await settle();

      assert.equal(doc.querySelectorAll('.endpoint-card').length, 1, 'the last good render stands');
      assert.equal(paths().length, 2);

      mock.timers.tick(10_000);
      await settle();
      assert.equal(paths().length, 3, 'the loop did not die with the request');
    } finally {
      console.error = realError;
    }
  });
});
