import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Who comes back, and in what order, once a Flatline group that had already
// triggered its actions reports healthy again.
//
// Targets are http ones whose restore request is a GET against a recording
// server, so the order they came back in is the order the requests arrived.
// That also covers 'http' being in AUTO_RESTORE_KINDS at all — it was added
// alongside the login auth scheme and nothing else exercises it.
//
// db.js opens a SQLite file at import time — point it at a throwaway dir before
// the dynamic import.
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-autorestore-'));
const store = await import('../server/db.js');
const { runAutoRestore, resolveWakeRelay } = await import('../server/autoRestore.js');
const { getTargetActivity, getRestoreProgress, isRestoring } = await import('../server/targetHealth.js');

/** Every restore request that arrived, in order, by target name. */
let arrivals = [];
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    arrivals.push(url.searchParams.get('t'));
    // ?ms=N holds the response open, so a test can call again mid-restore.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    }, Number(url.searchParams.get('ms')) || 0);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());
beforeEach(() => { arrivals = []; });

let seq = 0;

/** An http action target whose restore request names itself. */
function target(name, { auto_restore = 1, enabled = 1, restore = true } = {}) {
  const unique = `${name}-${++seq}`;
  return store.createActionTarget({
    name: unique,
    kind: 'http',
    config: JSON.stringify({
      url: `${base}/trigger?t=${unique}`,
      method: 'POST',
      auth_scheme: 'none',
      auto_restore,
      ...(restore ? { restore_url: `${base}/restore?t=${unique}`, restore_method: 'GET' } : {})
    }),
    secret_enc: null,
    enabled
  });
}

/** stages: [[target | { wait } ...]] — one array per stage. */
function actionGroup(name, stages, { enabled = 1 } = {}) {
  return store.createActionGroup({
    name: `${name}-${++seq}`,
    on_failure: 'continue',
    enabled,
    stages: stages.map((steps) => ({
      pass_rule: 'any',
      on_failure: null,
      wait_seconds: 0,
      steps: steps.map((s) => (s.wait != null ? { wait_seconds: s.wait } : { target_id: s.id, timeout_seconds: 30 }))
    }))
  });
}

/** The shape shutdown.js hands runAutoRestore: a Flatline group that recovered. */
function flatlineGroup(name, actionGroups) {
  return { id: ++seq, name, action_group_ids: actionGroups.map((g) => g.id) };
}

/** The names in `arrivals`, with the trailing uniquifier removed. */
const restored = () => arrivals.map((n) => n.replace(/-\d+$/, ''));

describe('the reverse walk', () => {
  test('stages come back in the reverse of the order they went down in', async () => {
    // Whatever was shut down last is brought back first, so a machine is never
    // asked to start before the thing it depends on.
    const a = target('first-down');
    const b = target('second-down');
    const c = target('last-down');
    const ag = actionGroup('shutdown', [[a], [b], [c]]);

    await runAutoRestore(flatlineGroup('lab', [ag]));
    assert.deepEqual(restored(), ['last-down', 'second-down', 'first-down']);
  });

  test('action groups come back in reverse too', async () => {
    const early = target('early');
    const late = target('late');
    const first = actionGroup('runs-first', [[early]]);
    const second = actionGroup('runs-second', [[late]]);

    await runAutoRestore(flatlineGroup('lab', [first, second]));
    assert.deepEqual(restored(), ['late', 'early']);
  });

  test('targets in the same stage come back together, before the stage above them', async () => {
    // Within a stage there is no order to keep — they went down together, so
    // they come back together. What matters is the stage boundary.
    const together = [target('pair'), target('pair')];
    const alone = target('solo');
    const ag = actionGroup('shutdown', [together, [alone]]);

    await runAutoRestore(flatlineGroup('lab', [ag]));
    assert.deepEqual(restored(), ['solo', 'pair', 'pair']);
  });

  test('a wait step has nothing to undo', async () => {
    const t = target('real');
    const ag = actionGroup('shutdown', [[{ wait: 30 }, t], [{ wait: 10 }]]);

    await runAutoRestore(flatlineGroup('lab', [ag]));
    assert.deepEqual(restored(), ['real']);
  });
});

describe('who takes part', () => {
  test('only targets with auto-restore ticked', async () => {
    const asked = target('asked', { auto_restore: 1 });
    const not = target('not-asked', { auto_restore: 0 });
    const ag = actionGroup('shutdown', [[asked, not]]);

    await runAutoRestore(flatlineGroup('lab', [ag]));
    assert.deepEqual(restored(), ['asked']);
  });

  test('a disabled target is left alone', async () => {
    const off = target('disabled', { enabled: 0 });
    const on = target('enabled');
    const ag = actionGroup('shutdown', [[off, on]]);

    await runAutoRestore(flatlineGroup('lab', [ag]));
    assert.deepEqual(restored(), ['enabled']);
  });

  test('a disabled action group takes no part', async () => {
    const t = target('in-disabled-group');
    const ag = actionGroup('shutdown', [[t]], { enabled: 0 });

    await runAutoRestore(flatlineGroup('lab', [ag]));
    assert.deepEqual(restored(), []);
  });

  test('an action group this Flatline group does not own is untouched', async () => {
    const mine = target('mine');
    const theirs = target('theirs');
    const ours = actionGroup('ours', [[mine]]);
    actionGroup('someone-elses', [[theirs]]);

    await runAutoRestore(flatlineGroup('lab', [ours]));
    assert.deepEqual(restored(), ['mine']);
  });

  test('a target with auto-restore but no restore request still reports', async () => {
    // It takes part in the walk and fails plainly, rather than being skipped in
    // silence — a ticked box that does nothing is worth surfacing.
    const t = target('no-request', { restore: false });
    const ag = actionGroup('shutdown', [[t]]);

    await runAutoRestore(flatlineGroup('lab', [ag]));
    assert.deepEqual(restored(), [], 'nothing was sent');
    assert.equal(getTargetActivity(t.id).ok, false);
    assert.match(getTargetActivity(t.id).message, /no restore request configured/);
  });
});

describe('a target used more than once', () => {
  test('restores once, at the first point the reverse walk reaches it', async () => {
    const shared = target('shared');
    const other = target('other');
    // Shut down in stage 1 and again in stage 3 — coming back twice would send
    // the restore request twice, and it need not be idempotent.
    const ag = actionGroup('shutdown', [[shared], [other], [shared]]);

    await runAutoRestore(flatlineGroup('lab', [ag]));
    assert.deepEqual(restored(), ['shared', 'other'], 'the last stage is first back');
  });

  test('and only once across action groups as well', async () => {
    const shared = target('shared');
    const first = actionGroup('runs-first', [[shared]]);
    const second = actionGroup('runs-second', [[shared]]);

    await runAutoRestore(flatlineGroup('lab', [first, second]));
    assert.deepEqual(restored(), ['shared']);
  });
});

describe('a group that flaps', () => {
  test('a second recovery while the first restore is still running is ignored', async () => {
    // A restore outlasts the 5s watcher tick by minutes; without the guard a
    // flapping group would start a second pass over the same machines.
    const slow = store.createActionTarget({
      name: `slow-${++seq}`, kind: 'http',
      config: JSON.stringify({
        url: `${base}/trigger`, method: 'POST', auth_scheme: 'none', auto_restore: 1,
        // Held open for 400ms, so the second call lands mid-flight.
        restore_url: `${base}/restore?ms=400&t=slow`, restore_method: 'GET'
      }),
      secret_enc: null, enabled: 1
    });
    const ag = actionGroup('shutdown', [[slow]]);
    const group = flatlineGroup('flapper', [ag]);

    const first = runAutoRestore(group);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runAutoRestore(group); // returns immediately — the guard is up
    await first;

    assert.equal(arrivals.length, 1, 'one pass, not two');

    // Once it finishes the guard is released, so a later recovery does restore.
    await runAutoRestore(group);
    assert.equal(arrivals.length, 2);
  });
});

describe('what a restore leaves behind', () => {
  test('the outcome lands on the target and in the event feed', async () => {
    const t = target('reported');
    const ag = actionGroup('shutdown', [[t]]);

    await runAutoRestore(flatlineGroup('recovered-lab', [ag]));

    const activity = getTargetActivity(t.id);
    assert.equal(activity.ok, true);
    assert.equal(activity.trigger, 'restore');

    // Recorded the same way a triggered action step is, so it reaches
    // notifications without a channel subscribing to anything new.
    const event = store.listEvents(20).find((e) => e.message.includes('recovered-lab'));
    assert.equal(event.kind, 'action_step_ok');
    assert.match(event.message, /Auto-restore after "recovered-lab" recovered/);
  });

  test('a target is marked as restoring while it comes back, and clear afterwards', async () => {
    // The page reads this to show a phase line, and the manual Restore button
    // reads it to refuse starting a second pass over the same target.
    const slow = store.createActionTarget({
      name: `watched-${++seq}`, kind: 'http',
      config: JSON.stringify({
        url: `${base}/trigger`, method: 'POST', auth_scheme: 'none', auto_restore: 1,
        restore_url: `${base}/restore?ms=300&t=watched`, restore_method: 'GET'
      }),
      secret_enc: null, enabled: 1
    });
    const ag = actionGroup('shutdown', [[slow]]);

    assert.equal(isRestoring(slow.id), false, 'nothing in flight to begin with');
    const running = runAutoRestore(flatlineGroup('watched-lab', [ag]));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(isRestoring(slow.id), true);
    const progress = getRestoreProgress(slow.id);
    assert.equal(typeof progress.startedAt, 'number');
    assert.equal(typeof progress.phase, 'string');

    await running;
    assert.equal(isRestoring(slow.id), false, 'cleared once it settled');
    assert.equal(getRestoreProgress(slow.id), null);
    assert.equal(getTargetActivity(slow.id).ok, true, 'and the outcome took its place');
  });

  test('nothing to restore means nothing recorded', async () => {
    const ag = actionGroup('shutdown', [[target('opted-out', { auto_restore: 0 })]]);
    const before = store.listEvents(50).length;

    await runAutoRestore(flatlineGroup('quiet-lab', [ag]));
    assert.equal(store.listEvents(50).length, before);
  });
});

describe('resolving the relay a target wakes through', () => {
  const relay = () => store.createRelay({
    name: `relay-${++seq}`, kind: 'ssh',
    config: JSON.stringify({ host: '10.1.20.5', username: 'pi', port: 22, auth_method: 'password' }),
    wake_command: 'wakeonlan {mac}', network: '10.1.20.0/24', secret_enc: null, enabled: 1
  });

  test('a target that broadcasts for itself needs no relay', () => {
    assert.equal(resolveWakeRelay({ wake_mode: 'packet', wake_relay_id: 1 }), null);
    assert.equal(resolveWakeRelay({}), null);
  });

  test('a configured relay comes back decrypted, with its command', () => {
    const r = relay();
    const resolved = resolveWakeRelay({ wake_mode: 'relay', wake_relay_id: r.id });
    assert.equal(resolved.name, r.name);
    assert.equal(resolved.kind, 'ssh');
    assert.equal(resolved.wake_command, 'wakeonlan {mac}');
    assert.equal(resolved.config.host, '10.1.20.5');
    assert.deepEqual(resolved.secrets, {});
  });

  test('a deleted or disabled relay resolves to null, so the wake reports it', () => {
    // restoreSequence turns a null relay into "that relay no longer exists"
    // rather than skipping the wake and waiting out the whole timeout.
    const gone = relay();
    store.deleteRelay(gone.id);
    assert.equal(resolveWakeRelay({ wake_mode: 'relay', wake_relay_id: gone.id }), null);

    const off = relay();
    store.updateRelay(off.id, { ...off, enabled: 0 });
    assert.equal(resolveWakeRelay({ wake_mode: 'relay', wake_relay_id: off.id }), null);
  });
});
