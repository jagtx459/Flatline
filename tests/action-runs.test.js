import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockTargets } from '../dev/mock-targets.js';

// db.js opens a SQLite file at import time — point it at a throwaway dir before
// the dynamic import, so the tests never touch the real data directory.
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-runs-'));
const store = await import('../server/db.js');
const runs = await import('../server/actionRuns.js');

let mock;
let mockPort;

before(async () => {
  mock = await startMockTargets(0); // ephemeral port
  mockPort = mock.address().port;
});
after(() => mock.close());

/** An HTTP action target that hits one of the mock routes. */
function target(name, route) {
  return store.createActionTarget({
    name, kind: 'http',
    config: JSON.stringify({ url: `http://127.0.0.1:${mockPort}${route}`, method: 'POST', auth_scheme: 'none' }),
    secret_enc: null, enabled: 1
  });
}

/**
 * stages: [[{ target, seconds } | { wait }]] — one array per stage, steps run
 * together; `wait` makes a wait step. `waits[i]` is the gap held before stage i,
 * and defaults to none here so tests about anything else run at full speed.
 */
function group(name, stages, { on_failure = 'continue', stageFailure = null, waits = [] } = {}) {
  return store.createActionGroup({
    name, on_failure, enabled: 1,
    stages: stages.map((steps, i) => ({
      pass_rule: 'any',
      on_failure: stageFailure,
      wait_seconds: waits[i] ?? 0,
      steps: steps.map((s) => (s.wait != null
        ? { wait_seconds: s.wait }
        : { target_id: s.target.id, timeout_seconds: s.seconds }))
    }))
  });
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

const status = (id) => store.getActionRun(id).status;
const steps = (id) => JSON.parse(store.getActionRun(id).steps);

test('a stage runs its steps at once, so it costs the slowest step, not their sum', async () => {
  const g = group('parallel', [[
    { target: target('slow-a', '/slow?ms=1200'), seconds: 30 },
    { target: target('slow-b', '/slow?ms=1200'), seconds: 30 }
  ]]);

  const started = Date.now();
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;
  const elapsed = Date.now() - started;

  assert.equal(status(run.id), 'completed');
  assert.ok(elapsed < 2400, `two 1.2s steps in one stage took ${elapsed}ms — they did not overlap`);
  assert.deepEqual(steps(run.id).map((s) => s.state), ['ok', 'ok']);
});

test("a step's timeout is a give-up limit, not a wait — a fast step returns fast", async () => {
  // 30s limit, but the target answers at once: the stage must not linger.
  const g = group('fast-under-a-long-limit', [[{ target: target('instant', '/up'), seconds: 30 }]]);

  const started = Date.now();
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;
  const elapsed = Date.now() - started;

  assert.equal(status(run.id), 'completed');
  assert.ok(elapsed < 1500, `a step with a 30s limit took ${elapsed}ms against an instant target`);
});

test('a step that outlasts its limit fails, and the run reports it', async () => {
  const g = group('timeout', [[{ target: target('hangs', '/hang'), seconds: 1 }]]);
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;

  assert.equal(status(run.id), 'failed');
  assert.deepEqual(steps(run.id).map((s) => s.state), ['failed']);
});

test('stages run in order and every step outcome is recorded', async () => {
  const ok = target('step-ok', '/up');
  const g = group('ordered', [[{ target: ok, seconds: 30 }], [{ target: ok, seconds: 30 }]]);
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'flatline', detail: 'Power loss' });

  assert.equal(store.getActionRun(run.id).stage_count, 2);
  await done;

  const finished = store.getActionRun(run.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.stage_index, 1); // ended on the last stage
  assert.equal(finished.trigger_detail, 'Power loss');
  assert.ok(finished.ended_at >= finished.started_at);
});

test("on_failure 'stop' halts the sequence; 'continue' finishes it but still reports failure", async () => {
  const bad = target('always-500', '/down');
  const good = target('always-200', '/up');

  const stopping = group('stops', [[{ target: bad, seconds: 30 }], [{ target: good, seconds: 30 }]],
    { stageFailure: 'stop' });
  const a = runs.startActionGroupRun(stopping, { trigger: 'manual' });
  await a.done;
  assert.equal(status(a.run.id), 'failed');
  assert.equal(store.getActionRun(a.run.id).stage_index, 0, 'stage 2 should never have started');

  const continuing = group('continues', [[{ target: bad, seconds: 30 }], [{ target: good, seconds: 30 }]]);
  const b = runs.startActionGroupRun(continuing, { trigger: 'manual' });
  await b.done;
  assert.equal(status(b.run.id), 'failed');
  assert.equal(store.getActionRun(b.run.id).stage_index, 1, 'stage 2 should still have run');
});

// ---- waits ----
// Two separate things: the gap held BETWEEN stages (stage.wait_seconds, 5s
// unless changed), and a wait step INSIDE a stage that holds it open.

const message = (id) => store.getActionRun(id).message ?? '';

test('stages are five seconds apart by default, and the first stage still starts at once', async () => {
  const ok = target('default-gap', '/up');
  // No wait_seconds anywhere in this payload — the stored default is what runs.
  const g = store.createActionGroup({
    name: 'default gap', on_failure: 'continue', enabled: 1,
    stages: [
      { pass_rule: 'any', on_failure: null, steps: [{ target_id: ok.id, timeout_seconds: 30 }] },
      { pass_rule: 'any', on_failure: null, steps: [{ target_id: ok.id, timeout_seconds: 30 }] }
    ]
  });
  assert.deepEqual(store.getActionGroup(g.id).stages.map((s) => s.wait_seconds), [5, 5]);

  const started = Date.now();
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;
  const elapsed = Date.now() - started;

  assert.equal(status(run.id), 'completed');
  assert.ok(elapsed >= 5000, `two instant stages took ${elapsed}ms — the 5s gap between them was not held`);
  // Stage 1's own wait_seconds is stored but never used: 10s would mean the run
  // sat on its hands before doing anything, which an outage cannot afford.
  assert.ok(elapsed < 9000, `the run took ${elapsed}ms — it waited before stage 1 as well`);
});

test('the gap between stages is reported on the run while it is being held', async () => {
  const ok = target('gap-visible', '/up');
  const g = group('shows-the-gap', [[{ target: ok, seconds: 30 }], [{ target: ok, seconds: 30 }]],
    { waits: [0, 3] });
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });

  await waitFor(() => /Waiting 3s before stage 2 of 2/.test(message(run.id)), 'the gap to be reported');
  const held = store.getActionRun(run.id);
  assert.equal(held.status, 'running', 'a gap is not a pause — the run is still going');
  assert.equal(held.stage_index, 0, 'stage 2 has not started yet');
  assert.ok(held.estimated_end_ts > Date.now(), 'the estimate still covers the gap and the stage after it');

  await done;
  assert.equal(status(run.id), 'completed');
});

test('the finish estimate counts the gaps, not just the work', async () => {
  const ok = target('gap-estimate', '/up');
  const g = group('estimated', [[{ target: ok, seconds: 10 }], [{ target: ok, seconds: 10 }]],
    { waits: [0, 30] });

  const started = Date.now();
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });

  // 10s of stage + a 30s gap + 10s of stage, measured from the row as created.
  const budget = run.estimated_end_ts - run.started_at;
  assert.ok(budget >= 50_000 && budget < 51_000, `estimated ${budget}ms for 10s + a 30s gap + 10s`);

  // Cancelled while stage 1 runs: the gap after it is never entered, so a run
  // that is already over does not hold the line for half a minute.
  runs.cancelRun(run.id);
  await done;
  assert.equal(status(run.id), 'cancelled');
  assert.ok(Date.now() - started < 5000, 'a cancelled run held the gap to a stage it would never run');
});

test('cancelling during a gap ends the run there instead of sitting out the rest', async () => {
  const ok = target('gap-cancel', '/up');
  const g = group('long-gap', [[{ target: ok, seconds: 30 }], [{ target: ok, seconds: 30 }]],
    { waits: [0, 30] });

  const started = Date.now();
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await waitFor(() => /Waiting 30s/.test(message(run.id)), 'the gap to start');
  assert.equal(runs.cancelRun(run.id), null);
  await done;
  const elapsed = Date.now() - started;

  assert.equal(status(run.id), 'cancelled');
  assert.equal(store.getActionRun(run.id).stage_index, 0, 'the stage after the gap must not run');
  assert.ok(elapsed < 5000, `the run sat out ${elapsed}ms of a 30s gap it was never going to use`);
});

test('a pause asked for during a gap takes hold as soon as the gap ends', async () => {
  const ok = target('gap-pause', '/up');
  const g = group('pausable-gap', [[{ target: ok, seconds: 30 }], [{ target: ok, seconds: 30 }]],
    { waits: [0, 2] });
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });

  await waitFor(() => /Waiting 2s/.test(message(run.id)), 'the gap to start');
  assert.equal(runs.pauseRun(run.id), null);
  await waitFor(() => status(run.id) === 'paused', 'the run to pause once the gap ended');
  assert.equal(store.getActionRun(run.id).stage_index, 0);

  assert.equal(runs.resumeRun(run.id), null);
  await done;
  assert.equal(status(run.id), 'completed');
});

test('a resume with nothing to release does not cut a gap short', async () => {
  const ok = target('gap-stray-resume', '/up');
  const g = group('unpaused-gap', [[{ target: ok, seconds: 30 }], [{ target: ok, seconds: 30 }]],
    { waits: [0, 4] });

  const started = Date.now();
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await waitFor(() => /Waiting 4s/.test(message(run.id)), 'the gap to start');
  assert.equal(runs.resumeRun(run.id), null); // the run is not paused — there is nothing to resume
  await done;

  const elapsed = Date.now() - started;
  assert.equal(status(run.id), 'completed');
  assert.ok(elapsed >= 4000, `the 4s gap ended after ${elapsed}ms — a stray resume released it`);
});

test('a wait step gates the steps below it: they start only once it is up', async () => {
  const first = target('runs-first', '/up');
  const second = target('runs-after-the-wait', '/up');
  const g = group('gated', [[{ target: first, seconds: 30 }, { wait: 2 }, { target: second, seconds: 30 }]]);

  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });

  // Mid-wait: the target above it is done, the one below has not started.
  await waitFor(() => steps(run.id)[1]?.state === 'running', 'the wait to start');
  assert.deepEqual(steps(run.id).map((s) => s.state), ['ok', 'running', 'pending']);

  await done;
  assert.equal(status(run.id), 'completed');
  assert.deepEqual(steps(run.id).map((s) => s.name), ['runs-first', 'wait 2s', 'runs-after-the-wait']);
  assert.deepEqual(steps(run.id).map((s) => s.state), ['ok', 'ok', 'ok']);
});

test('a wait step costs its full time, and the batches around it still run at once', async () => {
  const a = target('batched-a', '/slow?ms=1200');
  const b = target('batched-b', '/slow?ms=1200');
  const g = group('batched', [[
    { target: a, seconds: 30 }, { target: b, seconds: 30 },
    { wait: 2 },
    { target: a, seconds: 30 }, { target: b, seconds: 30 }
  ]]);

  const started = Date.now();
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;
  const elapsed = Date.now() - started;

  assert.equal(status(run.id), 'completed');
  // 1.2s batch + 2s wait + 1.2s batch. Sequential batches, parallel within one:
  // four 1.2s steps run one after another would be 4.8s + the wait.
  assert.ok(elapsed >= 4400, `the stage took ${elapsed}ms — the wait or a batch was skipped`);
  assert.ok(elapsed < 6000, `the stage took ${elapsed}ms — the steps in a batch did not overlap`);
});

test('a wait step at the end of a stage just holds it open', async () => {
  const ok = target('wait-last', '/up');
  const g = group('trailing-wait', [[{ target: ok, seconds: 30 }, { wait: 2 }]]);

  const started = Date.now();
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;

  assert.equal(status(run.id), 'completed');
  assert.ok(Date.now() - started >= 2000, 'a wait with nothing below it still held the stage');
  assert.deepEqual(steps(run.id).map((s) => s.state), ['ok', 'ok']);
});

test('cancelling during a wait step leaves the steps below it unrun', async () => {
  const first = target('cancel-gate-first', '/up');
  const second = target('cancel-gate-second', '/down'); // would fail the run had it started
  const g = group('cancel-mid-stage',
    [[{ target: first, seconds: 30 }, { wait: 30 }, { target: second, seconds: 30 }]]);

  const started = Date.now();
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await waitFor(() => steps(run.id)[1]?.state === 'running', 'the wait to start');
  assert.equal(runs.cancelRun(run.id), null);
  await done;
  const elapsed = Date.now() - started;

  assert.equal(status(run.id), 'cancelled');
  assert.ok(elapsed < 5000, `the run sat out ${elapsed}ms of a 30s wait after being cancelled`);
  // The wait keeps ⋯ — that is where the run stopped — and nothing below it ran.
  assert.deepEqual(steps(run.id).map((s) => s.state), ['ok', 'running', 'pending']);
  assert.match(store.getActionRun(run.id).message, /Cancelled during stage 1 of 1/);
});

test('the finish estimate counts a stage as batch + wait + batch', () => {
  const ok = target('gated-estimate', '/up');
  const g = group('gated-estimated', [[
    { target: ok, seconds: 10 }, { wait: 30 }, { target: ok, seconds: 10 }
  ]]);
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });

  // 10s + 30s + 10s. Were the stage still one parallel batch it would read 30s.
  const budget = run.estimated_end_ts - run.started_at;
  assert.ok(budget >= 50_000 && budget < 51_000, `estimated ${budget}ms for 10s + a 30s wait + 10s`);

  runs.cancelRun(run.id);
  return done;
});

test('a stage of nothing but a wait is a delay, and completes', async () => {
  const ok = target('after-the-delay', '/up');
  const g = group('delay-stage', [[{ wait: 1 }], [{ target: ok, seconds: 30 }]]);

  const started = Date.now();
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;

  assert.equal(status(run.id), 'completed');
  assert.ok(Date.now() - started >= 1000, 'the wait-only stage did not hold');
  assert.equal(store.getActionRun(run.id).stage_count, 2);
});

test('pause holds the run at the next stage boundary, and resume carries on', async () => {
  const slow = target('pause-slow', '/slow?ms=800');
  const g = group('pausable', [[{ target: slow, seconds: 30 }], [{ target: slow, seconds: 30 }]]);
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });

  assert.equal(runs.pauseRun(run.id), null);
  await waitFor(() => status(run.id) === 'paused', 'the run to pause');

  // Paused between the stages: stage 1 finished, stage 2 has not started.
  assert.equal(store.getActionRun(run.id).stage_index, 0);
  assert.equal(store.getActionRun(run.id).estimated_end_ts, null);

  // It really is holding — still paused a moment later, not quietly running on.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(status(run.id), 'paused');

  assert.equal(runs.resumeRun(run.id), null);
  await done;
  assert.equal(status(run.id), 'completed');
  assert.equal(store.getActionRun(run.id).stage_index, 1);
});

test('cancel stops the run before the next stage, leaving finished stages alone', async () => {
  const slow = target('cancel-slow', '/slow?ms=800');
  const g = group('cancellable', [[{ target: slow, seconds: 30 }], [{ target: slow, seconds: 30 }]]);
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });

  assert.equal(runs.cancelRun(run.id), null);
  await done;

  const finished = store.getActionRun(run.id);
  assert.equal(finished.status, 'cancelled');
  assert.equal(finished.stage_index, 0, 'the stage after the cancel must not run');
  assert.deepEqual(steps(run.id).map((s) => s.state), ['ok'], 'the stage already running still completed');
});

test('cancelling a paused run releases it', async () => {
  const slow = target('pause-cancel', '/slow?ms=600');
  const g = group('pause-then-cancel', [[{ target: slow, seconds: 30 }], [{ target: slow, seconds: 30 }]]);
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });

  runs.pauseRun(run.id);
  await waitFor(() => status(run.id) === 'paused', 'the run to pause');
  assert.equal(runs.cancelRun(run.id), null);
  await done;
  assert.equal(status(run.id), 'cancelled');
});

test('controls report a clear problem once a run is over', async () => {
  const g = group('done-already', [[{ target: target('quick', '/up'), seconds: 30 }]]);
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;

  assert.match(runs.pauseRun(run.id), /no longer controllable/);
  assert.match(runs.cancelRun(run.id), /no longer controllable/);
  assert.equal(runs.isRunning(g.id), false);
});

test('isRunning guards against starting the same action group twice', async () => {
  const g = group('single-flight', [[{ target: target('busy', '/slow?ms=700'), seconds: 30 }]]);
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  assert.equal(runs.isRunning(g.id), true);
  await done;
  assert.equal(runs.isRunning(g.id), false);
  assert.equal(store.getActionRun(run.id).ended_at !== null, true);
});

test('an action group with no stages completes immediately instead of hanging', async () => {
  const g = group('empty', []);
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;
  assert.equal(status(run.id), 'completed');
  assert.match(store.getActionRun(run.id).message, /no stages/);
});

test('every run records a start and an outcome, whatever started it', async () => {
  const ok = target('event-ok', '/up');
  const bad = target('event-bad', '/down');

  /** The run-level events naming one group — earlier tests share this log. */
  const runEvents = (name) => store.listEvents(50)
    .filter((e) => e.kind.startsWith('action_run_') && e.message.includes(`"${name}"`))
    .map((e) => e.kind);

  const good = group('emits-completed', [[{ target: ok, seconds: 30 }]]);
  await runs.startActionGroupRun(good, { trigger: 'flatline', detail: 'Power loss' }).done;
  assert.deepEqual(runEvents('emits-completed').sort(),
    ['action_run_completed', 'action_run_started'],
    'a Flatline-triggered run announces itself too');

  const doomed = group('emits-failed', [[{ target: bad, seconds: 30 }]]);
  await runs.startActionGroupRun(doomed, { trigger: 'manual' }).done;
  assert.deepEqual(runEvents('emits-failed').sort(),
    ['action_run_failed', 'action_run_started'],
    'a failed run does not also report success');
});

test('a cancelled run reports the same outcome event as a failed one', async () => {
  const slow = target('event-cancel', '/slow?ms=600');
  const g = group('emits-cancelled', [[{ target: slow, seconds: 30 }], [{ target: slow, seconds: 30 }]]);
  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });

  runs.cancelRun(run.id);
  await done;

  // A run that stopped early is news whether the user asked for it or not, so
  // cancel maps to the same event a failure does.
  const outcome = store.listEvents(10).find((e) => e.kind.startsWith('action_run_c') || e.kind === 'action_run_failed');
  assert.equal(outcome.kind, 'action_run_failed');
  assert.match(outcome.message, /CANCELLED/);
});

test('markInterruptedRuns closes out runs a stopped process left behind', () => {
  const g = group('orphan', [[{ target: target('orphan-target', '/up'), seconds: 30 }]]);
  const orphan = store.createActionRun({
    action_group_id: g.id, action_group_name: g.name, trigger: 'flatline',
    trigger_detail: 'Power loss', stage_count: 1, started_at: Date.now() - 60_000
  });
  assert.equal(status(orphan.id), 'running');

  runs.markInterruptedRuns();

  const closed = store.getActionRun(orphan.id);
  assert.equal(closed.status, 'interrupted');
  assert.ok(closed.ended_at);
  assert.match(closed.message, /Flatline stopped/);
  assert.match(runs.pauseRun(orphan.id), /no longer controllable/);
});

test('run history survives deleting the action group, and prunes with retention', () => {
  const g = group('temporary', [[{ target: target('temp-target', '/up'), seconds: 30 }]]);
  const old = store.createActionRun({
    action_group_id: g.id, action_group_name: g.name, trigger: 'manual',
    stage_count: 1, started_at: Date.now() - 30 * 86_400_000
  });
  store.updateActionRun(old.id, { status: 'completed', ended_at: Date.now() - 30 * 86_400_000 });

  store.deleteActionGroup(g.id);
  const orphaned = store.getActionRun(old.id);
  assert.equal(orphaned.action_group_id, null, 'the id is released');
  assert.equal(orphaned.action_group_name, 'temporary', 'but the name still reads correctly');

  store.pruneHistory(Date.now() - 14 * 86_400_000);
  assert.equal(store.getActionRun(old.id), undefined);
});

test('pruning keeps a live run that started before the retention window', () => {
  const g = group('long-runner', [[{ target: target('long-target', '/up'), seconds: 30 }]]);
  const live = store.createActionRun({
    action_group_id: g.id, action_group_name: g.name, trigger: 'manual',
    stage_count: 1, started_at: Date.now() - 30 * 86_400_000
  });

  store.pruneHistory(Date.now() - 14 * 86_400_000);
  assert.equal(store.getActionRun(live.id).status, 'running');
});
