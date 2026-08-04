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

/** stages: [[{ target, seconds }]] — one array per stage, steps run together. */
function group(name, stages, { on_failure = 'continue', stageFailure = null } = {}) {
  return store.createActionGroup({
    name, on_failure, enabled: 1,
    stages: stages.map((steps) => ({
      pass_rule: 'any',
      on_failure: stageFailure,
      steps: steps.map((s) => ({ target_id: s.target.id, timeout_seconds: s.seconds }))
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
