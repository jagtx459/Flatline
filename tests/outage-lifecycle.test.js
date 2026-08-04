import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockTargets } from '../dev/mock-targets.js';

// Point db.js at a throwaway dir before importing it — see config-transfer.test.js.
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-outage-'));
const store = await import('../server/db.js');
const { startShutdownWatcher, getGroupStates } = await import('../server/shutdown.js');

/**
 * The whole outage path in one go: healthy endpoints → both fail → the group
 * arms → its grace period elapses → its action group actually runs → the
 * endpoints recover → the group disarms.
 *
 * The poller's own timing is not involved: this writes the endpoint states the
 * poller would write (store.setEndpointState is exactly what poller.js calls on
 * a transition) and lets the real watcher react. The outage is dated one minute
 * back so the grace period has already elapsed, which keeps a test of a
 * minutes-long feature down to seconds.
 */

let mock;
let watcher;
let group;
let endpoints;
let actionGroup;

before(async () => {
  mock = await startMockTargets(0);
  const port = mock.address().port;

  const target = store.createActionTarget({
    name: 'shutdown-everything', kind: 'http',
    config: JSON.stringify({ url: `http://127.0.0.1:${port}/up`, method: 'POST', auth_scheme: 'none' }),
    secret_enc: null, enabled: 1
  });
  actionGroup = store.createActionGroup({
    name: 'lifecycle actions', on_failure: 'continue', enabled: 1,
    stages: [{ pass_rule: 'any', on_failure: null, steps: [{ target_id: target.id, timeout_seconds: 30 }] }]
  });

  const endpoint = (name) => store.createEndpoint({
    name, type: 'http', target: `http://127.0.0.1:${port}/scenario`,
    interval_seconds: 10, timeout_ms: 2000, down_threshold: 2, up_threshold: 2,
    expect_status: 200, expect_json: null, enabled: 1
  });
  endpoints = [endpoint('ups'), endpoint('lab-api')];

  group = store.createFlatlineGroup({
    name: 'lifecycle group', grace_minutes: 1, mode: 'all', enabled: 1,
    endpoint_ids: endpoints.map((e) => e.id),
    action_group_ids: [actionGroup.id]
  });

  watcher = startShutdownWatcher();
});

after(() => {
  clearInterval(watcher);
  mock.close();
});

const state = () => getGroupStates().find((g) => g.group_id === group.id);
const setAll = (s, ts) => endpoints.forEach((e) => store.setEndpointState(e.id, s, ts));

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

test('endpoints up for a while: the group stays quiet', async () => {
  setAll('up', Date.now());
  // Give the watcher a couple of passes to prove it does nothing.
  await new Promise((r) => setTimeout(r, 6000));

  const s = state();
  assert.equal(s.down_count, 0);
  assert.equal(s.endpoint_count, 2);
  assert.equal(s.armed, false, 'a healthy group must not arm');
  assert.equal(s.triggered, false);
  assert.equal(store.listActionRuns(10).length, 0, 'nothing should have run yet');
});

test('endpoints go down: the group arms, the grace period elapses, and its actions run', async () => {
  // Dated a minute back, so the 1 minute grace period is already spent — the
  // same state the watcher would see after a real outage it had been counting.
  setAll('down', Date.now() - 61_000);

  await waitFor(() => state().armed, 'the group to arm');
  assert.equal(state().down_count, 2);

  await waitFor(() => state().triggered, 'the grace period to elapse and trigger');
  await waitFor(() => store.listActionRuns(10).length > 0, 'an action run to be created');

  const run = store.listActionRuns(10)[0];
  assert.equal(run.action_group_name, 'lifecycle actions');
  assert.equal(run.trigger, 'flatline');
  assert.equal(run.trigger_detail, 'lifecycle group');

  await waitFor(() => store.getActionRun(run.id).status === 'completed', 'the run to finish');
  assert.deepEqual(JSON.parse(store.getActionRun(run.id).steps).map((s) => s.state), ['ok']);

  // The trigger is recorded for the dashboard's event feed too.
  const kinds = store.listEvents(20).map((e) => e.kind);
  assert.ok(kinds.includes('shutdown_armed'), 'an armed event should be recorded');
  assert.ok(kinds.includes('shutdown_triggered'), 'a triggered event should be recorded');
});

test('endpoints come back up: the group disarms and does not re-run', async () => {
  const runsAtRecovery = store.listActionRuns(50).length;
  setAll('up', Date.now());

  await waitFor(() => !state().armed, 'the group to disarm');
  const s = state();
  assert.equal(s.triggered, false, 'the triggered flag must clear on recovery');
  assert.equal(s.down_count, 0);
  assert.equal(s.deadline_ts, null);

  assert.ok(store.listEvents(20).some((e) => e.kind === 'shutdown_disarmed'), 'a disarmed event should be recorded');

  // Staying up must not start anything new.
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal(store.listActionRuns(50).length, runsAtRecovery, 'recovery must not start another run');
});

test('a second outage arms and fires again', async () => {
  const before = store.listActionRuns(50).length;
  setAll('down', Date.now() - 61_000);

  await waitFor(() => state().triggered, 'the group to trigger a second time');
  await waitFor(() => store.listActionRuns(50).length > before, 'a second action run');

  setAll('up', Date.now());
  await waitFor(() => !state().armed, 'the group to disarm again');
});
