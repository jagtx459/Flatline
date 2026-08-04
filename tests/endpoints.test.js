import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startMockTargets } from '../dev/mock-targets.js';

// What the Flatline page configures: endpoints, the groups they belong to, and
// the checks that decide whether one is up.
//
// db.js opens a SQLite file at import time — point it at a throwaway dir before
// the dynamic import, so the tests never touch the real data directory.
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-endpoints-'));
const store = await import('../server/db.js');
const { runCheck } = await import('../server/checks.js');
const { getGroupStates } = await import('../server/shutdown.js');
const { reschedule } = await import('../server/poller.js');

let mock;
let base;

before(async () => {
  mock = await startMockTargets(0); // ephemeral port
  base = `http://127.0.0.1:${mock.address().port}`;
});
after(() => mock.close());

/** An endpoint row with the form's defaults, overridable per test. */
function endpoint(over = {}) {
  return store.createEndpoint({
    name: 'endpoint', type: 'http', target: `${base}/up`,
    interval_seconds: 30, timeout_ms: 2000, down_threshold: 2, up_threshold: 2,
    expect_status: null, expect_json: null, enabled: 1, ...over
  });
}

// ---- endpoints and their groups ----

test('a new endpoint keeps its HTTP options and starts in the unknown state', () => {
  const ep = endpoint({
    name: 'api', expect_status: 204, expect_json: '{"status":"ok"}',
    interval_seconds: 15, timeout_ms: 900, down_threshold: 4, up_threshold: 3
  });

  const stored = store.getEndpoint(ep.id);
  assert.equal(stored.expect_status, 204);
  assert.equal(stored.expect_json, '{"status":"ok"}');
  assert.equal(stored.down_threshold, 4);
  assert.equal(stored.up_threshold, 3);
  assert.equal(stored.timeout_ms, 900);
  // Nothing has been checked yet, so it is neither up nor down.
  assert.equal(stored.last_state, 'unknown');
});

test('one endpoint can sit in several groups, and a group owns only its own membership', () => {
  const shared = endpoint({ name: 'shared' });
  const solo = endpoint({ name: 'solo' });

  const a = store.createFlatlineGroup({
    name: 'group a', grace_minutes: 5, mode: 'all', enabled: 1,
    action_group_ids: [], endpoint_ids: [shared.id, solo.id]
  });
  const b = store.createFlatlineGroup({
    name: 'group b', grace_minutes: 5, mode: 'any', enabled: 1,
    action_group_ids: [], endpoint_ids: [shared.id]
  });

  assert.deepEqual(store.getFlatlineGroup(a.id).endpoint_ids, [shared.id, solo.id]);
  assert.deepEqual(store.getFlatlineGroup(b.id).endpoint_ids, [shared.id]);

  // Emptying group b must not touch group a's copy of the same endpoint.
  store.updateFlatlineGroup(b.id, {
    name: 'group b', grace_minutes: 5, mode: 'any', enabled: 1,
    action_group_ids: [], endpoint_ids: []
  });
  assert.deepEqual(store.getFlatlineGroup(b.id).endpoint_ids, []);
  assert.deepEqual(store.getFlatlineGroup(a.id).endpoint_ids, [shared.id, solo.id]);
});

test('deleting an endpoint drops it from its groups and leaves the groups standing', () => {
  const doomed = endpoint({ name: 'doomed' });
  const keeper = endpoint({ name: 'keeper' });
  const g = store.createFlatlineGroup({
    name: 'mixed', grace_minutes: 5, mode: 'all', enabled: 1,
    action_group_ids: [], endpoint_ids: [doomed.id, keeper.id]
  });

  store.deleteEndpoint(doomed.id);

  const after = store.getFlatlineGroup(g.id);
  assert.deepEqual(after.endpoint_ids, [keeper.id]);
  assert.equal(after.endpoint_count, 1);
  assert.ok(store.getEndpoint(keeper.id), 'the surviving endpoint is untouched');
});

test('deleting a group leaves its endpoints and action groups in place', () => {
  const ep = endpoint({ name: 'still here' });
  const ag = store.createActionGroup({ name: 'still here too', on_failure: 'continue', enabled: 1, stages: [] });
  const g = store.createFlatlineGroup({
    name: 'temporary', grace_minutes: 5, mode: 'all', enabled: 1,
    action_group_ids: [ag.id], endpoint_ids: [ep.id]
  });

  store.deleteFlatlineGroup(g.id);

  assert.equal(store.getFlatlineGroup(g.id), undefined);
  assert.ok(store.getEndpoint(ep.id));
  assert.ok(store.getActionGroup(ag.id));
});

test('a group counts only its enabled members as down', () => {
  const down = endpoint({ name: 'down member' });
  const up = endpoint({ name: 'up member' });
  const paused = endpoint({ name: 'paused member', enabled: 0 });
  const g = store.createFlatlineGroup({
    name: 'counted', grace_minutes: 5, mode: 'all', enabled: 1,
    action_group_ids: [], endpoint_ids: [down.id, up.id, paused.id]
  });

  store.setEndpointState(down.id, 'down', Date.now());
  store.setEndpointState(up.id, 'up', Date.now());
  store.setEndpointState(paused.id, 'down', Date.now());

  const state = getGroupStates().find((s) => s.group_id === g.id);
  // A paused endpoint is out of the picture entirely — it can neither hold the
  // group down nor count towards the total it would take to trigger.
  assert.equal(state.endpoint_count, 2);
  assert.equal(state.down_count, 1);
});

// ---- the check itself ----

test('an HTTP check passes on 2xx and fails on 5xx, saying which status it got', async () => {
  const ok = await runCheck(endpoint({ name: 'healthy', target: `${base}/up` }));
  assert.equal(ok.ok, true);
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.latencyMs >= 0);

  const bad = await runCheck(endpoint({ name: 'broken', target: `${base}/down` }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unexpected status 500/);
});

test('expect_status makes one specific code the pass condition', async () => {
  // /down answers 500. Expecting 500 makes that the healthy answer...
  const expecting500 = await runCheck(endpoint({
    name: 'expects 500', target: `${base}/down`, expect_status: 500
  }));
  assert.equal(expecting500.ok, true);

  // ...and a 200 then counts as the failure.
  const expecting204 = await runCheck(endpoint({
    name: 'expects 204', target: `${base}/up`, expect_status: 204
  }));
  assert.equal(expecting204.ok, false);
  assert.match(expecting204.error, /unexpected status 200/);
});

test('expect_json matches a subset of the body, and rejects a mismatch', async () => {
  // /up answers {"status":"ok"}.
  const matching = await runCheck(endpoint({
    name: 'json match', target: `${base}/up`, expect_json: '{"status":"ok"}'
  }));
  assert.equal(matching.ok, true);

  const mismatched = await runCheck(endpoint({
    name: 'json mismatch', target: `${base}/up`, expect_json: '{"status":"degraded"}'
  }));
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.error, /did not match/);
});

test('a check that outlasts timeout_ms fails as a timeout rather than hanging', async () => {
  const started = Date.now();
  const result = await runCheck(endpoint({ name: 'hangs', target: `${base}/hang`, timeout_ms: 400 }));
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  assert.ok(elapsed < 3000, `a 400ms timeout took ${elapsed}ms to give up`);
});

test('an unreachable target fails without throwing', async () => {
  // Port 1 on loopback: nothing listens, so the connection is refused outright.
  const result = await runCheck(endpoint({ name: 'refused', target: 'http://127.0.0.1:1/', timeout_ms: 1000 }));
  assert.equal(result.ok, false);
  assert.ok(result.error, 'the failure is reported, not swallowed');
});

// ---- the threshold state machine ----

test('the poller flips state only once the threshold is met', async (t) => {
  // The real poller on a real socket, so this covers the whole path the page
  // promises: N consecutive failures to go down, M successes to come back.
  //
  // The poller's floor is one check every 5s, so the thresholds are kept small
  // and deliberately asymmetric — two failures to go down (proving one failure
  // is not enough), one success to recover — to keep this under ~20s.
  let healthy = true;
  const flaky = http.createServer((req, res) => {
    res.writeHead(healthy ? 200 : 503);
    res.end();
  });
  await new Promise((r) => flaky.listen(0, '127.0.0.1', r));

  // The poller schedules every enabled endpoint in the database, so clear the
  // fixtures the earlier tests left behind — otherwise they get checked too,
  // and their timers keep this process alive after the test ends.
  for (const stale of store.listEndpoints()) store.deleteEndpoint(stale.id);

  const ep = endpoint({
    name: 'flaky', target: `http://127.0.0.1:${flaky.address().port}/`,
    interval_seconds: 5, down_threshold: 2, up_threshold: 1
  });

  t.after(() => {
    store.deleteEndpoint(ep.id);
    reschedule(); // drops this endpoint's timer, so the process can exit
    flaky.close();
  });

  const stateOf = () => store.getEndpoint(ep.id).last_state;
  const waitFor = async (want, label, timeoutMs = 25_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (stateOf() === want) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`timed out waiting for ${label} (state is "${stateOf()}")`);
  };

  reschedule(); // picks up the new endpoint and starts checking

  // The very first observation decides immediately — thresholds only guard
  // transitions, so a new endpoint doesn't sit on "unknown" for two intervals.
  await waitFor('up', 'the first check to report UP');

  healthy = false;
  const checksBefore = store.recentChecks(ep.id, 50).length;
  await waitFor('down', 'two consecutive failures to flip it DOWN');
  const failures = store.recentChecks(ep.id, 50).length - checksBefore;
  assert.ok(failures >= 2, `it went down after ${failures} check(s) — one failure should not have been enough`);

  healthy = true;
  await waitFor('up', 'a success to bring it back UP');

  // Each transition is on the record for the dashboard's event list.
  const transitions = store.listEvents(20).filter((e) => e.kind === 'state' && e.endpoint_id === ep.id);
  assert.deepEqual(transitions.map((e) => e.to_state).reverse(), ['up', 'down', 'up']);
});
