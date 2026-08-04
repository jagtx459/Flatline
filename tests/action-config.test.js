import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockTargets } from '../dev/mock-targets.js';

// What the Actions page configures: action targets, and the staged groups built
// from them. How those groups execute is tests/action-runs.test.js — this file
// covers how they are stored, edited, and wired to Flatline groups.
//
// db.js opens a SQLite file at import time — point it at a throwaway dir before
// the dynamic import, so the tests never touch the real data directory.
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-actions-'));
const store = await import('../server/db.js');
const { encryptSecrets, secretKeys } = await import('../server/secrets.js');
const runs = await import('../server/actionRuns.js');

let mock;
let mockPort;

before(async () => {
  mock = await startMockTargets(0); // ephemeral port
  mockPort = mock.address().port;
});
after(() => mock.close());

function target(name, route = '/up', over = {}) {
  return store.createActionTarget({
    name, kind: 'http',
    config: JSON.stringify({ url: `http://127.0.0.1:${mockPort}${route}`, method: 'POST', auth_scheme: 'none' }),
    secret_enc: null, enabled: 1, ...over
  });
}

/** stages: [[{ target, seconds }]] — one array per stage, steps run together. */
function group(name, stages, { on_failure = 'continue', passRule = 'any', stageFailure = null } = {}) {
  return store.createActionGroup({
    name, on_failure, enabled: 1,
    stages: stages.map((steps) => ({
      pass_rule: passRule,
      on_failure: stageFailure,
      steps: steps.map((s) => ({ target_id: s.target.id, timeout_seconds: s.seconds ?? 30 }))
    }))
  });
}

// ---- action targets ----

test('a target keeps its kind and config, and its secret stays an opaque blob', () => {
  const t = store.createActionTarget({
    name: 'nas', kind: 'ssh',
    config: JSON.stringify({ host: '10.0.0.5', username: 'root', port: 22, auth_method: 'password', command: 'poweroff' }),
    secret_enc: encryptSecrets({ password: 'hunter2', passphrase: '' }),
    enabled: 1
  });

  const stored = store.getActionTarget(t.id);
  assert.equal(stored.kind, 'ssh');
  assert.equal(JSON.parse(stored.config).command, 'poweroff');

  // The page may show WHICH secrets are set, never their values — and the
  // stored blob must not carry the plaintext in any readable form.
  assert.deepEqual(secretKeys(stored.secret_enc), ['password'], 'an empty field is not stored at all');
  assert.ok(!stored.secret_enc.includes('hunter2'));
  assert.ok(!stored.config.includes('hunter2'));
});

test('a target with no secrets stores no blob at all', () => {
  const t = target('no-secrets');
  assert.equal(store.getActionTarget(t.id).secret_enc, null);
  assert.deepEqual(secretKeys(null), []);
});

// ---- staged action groups ----

test('a group round-trips its stages, their order, and each stage policy', () => {
  const first = target('stage-1-target');
  const second = target('stage-2-target');
  const third = target('stage-2-other');

  const g = store.createActionGroup({
    name: 'ordered', on_failure: 'stop', enabled: 1,
    stages: [
      { pass_rule: 'any', on_failure: null, steps: [{ target_id: first.id, timeout_seconds: 10 }] },
      { pass_rule: 'all', on_failure: 'continue', steps: [
        { target_id: second.id, timeout_seconds: 20 },
        { target_id: third.id, timeout_seconds: 30 }
      ] }
    ]
  });

  const stored = store.getActionGroup(g.id);
  assert.equal(stored.stages.length, 2);
  assert.equal(stored.on_failure, 'stop');

  // Stage order, and step order within a stage, are both the order they were saved in.
  assert.deepEqual(stored.stages[0].steps.map((s) => s.target_id), [first.id]);
  assert.deepEqual(stored.stages[1].steps.map((s) => s.target_id), [second.id, third.id]);
  assert.deepEqual(stored.stages[1].steps.map((s) => s.timeout_seconds), [20, 30]);

  assert.equal(stored.stages[1].pass_rule, 'all');
  assert.equal(stored.stages[1].on_failure, 'continue');
  // null means "use the group's setting" — it must survive as null, not become 'stop'.
  assert.equal(stored.stages[0].on_failure, null);
});

test('the same target can appear in more than one stage', () => {
  const reused = target('drained-twice');
  const g = group('reuse', [[{ target: reused }], [{ target: reused, seconds: 90 }]]);

  const stored = store.getActionGroup(g.id);
  assert.equal(stored.stages.length, 2);
  assert.deepEqual(stored.stages[0].steps, [{ target_id: reused.id, timeout_seconds: 30 }]);
  assert.deepEqual(stored.stages[1].steps, [{ target_id: reused.id, timeout_seconds: 90 }]);
});

test('editing a group replaces its stages outright, leaving no orphaned steps', () => {
  const a = target('kept');
  const b = target('dropped');
  const g = group('edited', [[{ target: a }, { target: b }], [{ target: b }]]);

  store.updateActionGroup(g.id, {
    name: 'edited', on_failure: 'continue', enabled: 1,
    stages: [{ pass_rule: 'any', on_failure: null, steps: [{ target_id: a.id, timeout_seconds: 45 }] }]
  });

  const stored = store.getActionGroup(g.id);
  assert.equal(stored.stages.length, 1, 'the removed stage is gone');
  assert.deepEqual(stored.stages[0].steps, [{ target_id: a.id, timeout_seconds: 45 }]);
  // The dropped target still exists on its own — only its membership went away.
  assert.ok(store.getActionTarget(b.id));
});

test('deleting a target takes its steps out of every group that used it', () => {
  const doomed = target('about-to-go');
  const keeper = target('stays');
  const one = group('uses-doomed-a', [[{ target: doomed }, { target: keeper }]]);
  const two = group('uses-doomed-b', [[{ target: doomed }]]);

  store.deleteActionTarget(doomed.id);

  // A group can quietly lose a step this way, so the remaining shape matters.
  assert.deepEqual(store.getActionGroup(one.id).stages[0].steps.map((s) => s.target_id), [keeper.id]);
  assert.deepEqual(store.getActionGroup(two.id).stages[0].steps, [], 'the stage survives, now empty');
});

// ---- wiring to Flatline groups ----

test('a group knows how many Flatline groups run it', () => {
  const ag = store.createActionGroup({ name: 'assigned', on_failure: 'continue', enabled: 1, stages: [] });
  assert.equal(store.getActionGroup(ag.id).assigned_count, 0);

  for (const name of ['watcher a', 'watcher b']) {
    store.createFlatlineGroup({
      name, grace_minutes: 5, mode: 'all', enabled: 1,
      action_group_ids: [ag.id], endpoint_ids: []
    });
  }
  assert.equal(store.getActionGroup(ag.id).assigned_count, 2);
});

test('deleting an action group unassigns it, leaving the Flatline group standing', () => {
  const doomed = store.createActionGroup({ name: 'doomed actions', on_failure: 'continue', enabled: 1, stages: [] });
  const kept = store.createActionGroup({ name: 'kept actions', on_failure: 'continue', enabled: 1, stages: [] });
  const fg = store.createFlatlineGroup({
    name: 'runs both', grace_minutes: 5, mode: 'all', enabled: 1,
    action_group_ids: [doomed.id, kept.id], endpoint_ids: []
  });

  store.deleteActionGroup(doomed.id);

  const after = store.getFlatlineGroup(fg.id);
  assert.ok(after, 'the Flatline group is not dragged down with it');
  assert.deepEqual(after.action_group_ids, [kept.id]);
});

// ---- the stage's own failure rule ----
// The page words this as "Counts as failed when [any target fails | all targets
// fail]", so these two runs pin that wording to what actually happens.

test('"counts as failed when any target fails" fails the stage on one bad step', async () => {
  const g = group('any-fails', [[{ target: target('any-ok', '/up') }, { target: target('any-bad', '/down') }]],
    { passRule: 'any' });

  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;

  assert.equal(store.getActionRun(run.id).status, 'failed');
  assert.deepEqual(JSON.parse(store.getActionRun(run.id).steps).map((s) => s.state), ['ok', 'failed']);
});

test('a disabled target is skipped, and the rest of the stage still runs', async () => {
  const off = target('disabled-target', '/down', { enabled: 0 });
  const on = target('enabled-target', '/up');
  const g = group('skips-what-is-off', [[{ target: off }, { target: on }]], { passRule: 'any' });

  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;

  const finished = store.getActionRun(run.id);
  assert.deepEqual(JSON.parse(finished.steps).map((s) => s.state), ['skipped', 'ok']);
  // /down would have failed the stage had it actually been called, so
  // "completed" is the proof that nothing was sent to the disabled target.
  assert.equal(finished.status, 'completed');

  const skips = store.listEvents(10).filter((e) => e.kind === 'action_step_skipped');
  assert.equal(skips.length, 1);
  assert.match(skips[0].message, /disabled-target.*this target is disabled/);
});

test('a stage of nothing but disabled targets has not failed', async () => {
  const off = target('all-disabled', '/down', { enabled: 0 });
  const g = group('nothing-to-do', [[{ target: off }]], { passRule: 'all' });

  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;

  assert.equal(store.getActionRun(run.id).status, 'completed');
  assert.deepEqual(JSON.parse(store.getActionRun(run.id).steps).map((s) => s.state), ['skipped']);
});

test('"counts as failed when all targets fail" lets a stage pass on one good step', async () => {
  const g = group('all-fail', [[{ target: target('all-ok', '/up') }, { target: target('all-bad', '/down') }]],
    { passRule: 'all' });

  const { run, done } = runs.startActionGroupRun(g, { trigger: 'manual' });
  await done;

  // Same steps, same outcomes as the test above — only the rule differs.
  assert.equal(store.getActionRun(run.id).status, 'completed');
  assert.deepEqual(JSON.parse(store.getActionRun(run.id).steps).map((s) => s.state), ['ok', 'failed']);
});
