import * as store from './db.js';
import { decryptSecrets } from './secrets.js';
import { runStep } from './connectors.js';
import { recordTargetActivity } from './targetHealth.js';

/**
 * Runs action groups and tracks each execution as a "run" the dashboard can
 * watch and steer.
 *
 * A run's progress lives in the action_runs table so it survives a restart;
 * the pause/cancel switches live in memory, because only the process actually
 * executing a run can act on them.
 *
 * Pause and cancel take effect at stage boundaries. A step that is already
 * executing is a command running on a remote host — it can't be recalled — so
 * the stage always finishes (or times out) before the run stops.
 *
 * Stages are separated by a deliberate wait (see stage.wait_seconds), which is
 * part of that boundary: nothing has been sent to a machine during it, so a
 * cancel cuts it short rather than sitting it out.
 *
 * An action group set to stop_on_restore adds one more thing that ends a run at
 * a stage boundary: the Flatline group that started it coming back. The stages
 * below it would be answering an outage that is over, so they never run.
 *
 * A wait step *inside* a stage splits it: the steps before it start together,
 * the wait is held, and only then do the steps after it start. So a stage runs
 * as a sequence of parallel batches, and the order of its steps matters. Those
 * waits are cancellable for the same reason the ones between stages are —
 * nothing has been sent for the batches below them yet.
 */

/** run id -> control switches, only for runs this process is executing. */
const controls = new Map();

/** Any run still marked live at startup was cut off by the process stopping. */
export function markInterruptedRuns() {
  for (const run of store.listLiveActionRuns()) {
    store.updateActionRun(run.id, {
      status: 'interrupted',
      ended_at: Date.now(),
      estimated_end_ts: null,
      message: 'Flatline stopped while this run was in progress'
    });
    recordOutcome(store.getActionRun(run.id));
    console.log(`[runs] run ${run.id} ("${run.action_group_name}") marked interrupted`);
  }
}

/**
 * One event per finished run, split by outcome so a channel can subscribe to
 * the bad news alone. Cancelled and interrupted count as failures: either way
 * the sequence did not run to the end.
 */
function recordOutcome(run) {
  store.recordEvent({
    ts: Date.now(),
    kind: run.status === 'completed' ? 'action_run_completed' : 'action_run_failed',
    message: `"${run.action_group_name}" ${run.status.toUpperCase()} — ${run.message}`
  });
}

/**
 * Worst case for a stage. Its wait steps split it into batches that run one
 * after another, so the cost is every wait plus, per batch, its slowest step —
 * a stage with no waits is one batch, and costs exactly that batch's slowest.
 */
function stageWorstCaseMs(stage) {
  let total = 0;
  let batch = 0;
  for (const step of stage.steps) {
    if (step.target_id == null) {
      total += batch + step.wait_seconds * 1000;
      batch = 0;
    } else {
      batch = Math.max(batch, step.timeout_seconds * 1000);
    }
  }
  return total + batch;
}

/**
 * Time left from the moment stage `fromIndex` starts running: every stage from
 * there on, plus the wait before each — except its own, which by then has
 * already been held (and which the first stage never has at all).
 */
function remainingWorstCaseMs(stages, fromIndex) {
  return stages.slice(fromIndex).reduce((ms, st, i) =>
    ms + (i > 0 ? st.wait_seconds * 1000 : 0) + stageWorstCaseMs(st), 0);
}

export function isRunning(actionGroupId) {
  return store.listLiveActionRuns().some((r) => r.action_group_id === actionGroupId);
}

/**
 * The Flatline group a run was started for, when it is no longer down and this
 * action group asked to stop there. Null in every other case: a manual run with
 * no group behind it, a group deleted mid-run, or one still down.
 *
 * "Restored" is the group's own all/any rule read in reverse — whatever counted
 * as down is what has to stop counting for the run to give up.
 */
function recoveredFlatlineGroup(actionGroup, flatlineGroupId) {
  if (!actionGroup.stop_on_restore || flatlineGroupId == null) return null;
  const group = store.getFlatlineGroup(flatlineGroupId);
  return group && !store.isFlatlineGroupDown(group) ? group : null;
}

/**
 * Starts an action group. Returns { run, done } — `run` is the row as created
 * (so a caller can respond immediately) and `done` resolves when the run
 * finishes, for callers that need the stages to complete before moving on. It
 * resolves to the set of target ids the run actually acted on, which is what a
 * restore afterwards has to undo — the stages a stopped run never reached are
 * not in it.
 *
 * `flatlineGroupId` is the group that triggered this run, so it can be watched
 * for a recovery; a manual run has none.
 */
export function startActionGroupRun(actionGroup, { trigger, detail = null, flatlineGroupId = null }) {
  const stages = actionGroup.stages ?? [];
  const run = store.createActionRun({
    action_group_id: actionGroup.id,
    action_group_name: actionGroup.name,
    trigger,
    trigger_detail: detail,
    stage_count: stages.length,
    started_at: Date.now(),
    estimated_end_ts: stages.length ? Date.now() + remainingWorstCaseMs(stages, 0) : Date.now()
  });

  // Recorded here rather than at the call sites, so a run started by a
  // Flatline group is announced the same way as one started from the dashboard.
  store.recordEvent({
    ts: Date.now(),
    kind: 'action_run_started',
    message: `"${actionGroup.name}" started ${trigger === 'manual' ? 'manually' : `by "${detail}"`}`
      + ` — ${stages.length} stage(s)`
  });

  controls.set(run.id, { pause: false, paused: false, cancel: false, wake: null });
  const done = execute(run.id, actionGroup, stages, flatlineGroupId)
    .catch((err) => {
      console.error(`[runs] run ${run.id} ("${actionGroup.name}") failed unexpectedly:`, err);
      finish(run.id, 'failed', `Run failed unexpectedly: ${err.message}`);
      return new Set();
    })
    .finally(() => controls.delete(run.id));

  return { run, done };
}

function finish(runId, status, message) {
  store.updateActionRun(runId, {
    status, message, ended_at: Date.now(), estimated_end_ts: null
  });
  recordOutcome(store.getActionRun(runId));
}

async function execute(runId, actionGroup, stages, flatlineGroupId) {
  const ctl = controls.get(runId);
  /** Targets this run acted on, for whoever restores afterwards. */
  const ran = new Set();

  if (stages.length === 0) {
    finish(runId, 'completed', 'Nothing to do — this action group has no stages');
    return ran;
  }

  let failedStages = 0;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];

    // The gap between stages, held before the pause/cancel checks so a request
    // made during it is honoured the moment it ends — and a cancel ends it now.
    // A run cancelled earlier skips the gap outright: there is no next stage to
    // hold it open for.
    if (!ctl.cancel && i > 0 && stage.wait_seconds > 0) {
      store.updateActionRun(runId, {
        status: 'running',
        estimated_end_ts: Date.now() + stage.wait_seconds * 1000 + remainingWorstCaseMs(stages, i),
        message: `Waiting ${stage.wait_seconds}s before stage ${i + 1} of ${stages.length}`
      });
      console.log(`[runs] "${actionGroup.name}" waiting ${stage.wait_seconds}s before stage ${i + 1}`);
      await sleep(ctl, stage.wait_seconds * 1000);
    }

    if (ctl.cancel) {
      finish(runId, 'cancelled', `Cancelled before stage ${i + 1} of ${stages.length}`);
      return ran;
    }
    if (ctl.pause) {
      store.updateActionRun(runId, {
        status: 'paused',
        estimated_end_ts: null,
        message: `Paused before stage ${i + 1} of ${stages.length}`
      });
      console.log(`[runs] run ${runId} ("${actionGroup.name}") paused before stage ${i + 1}`);
      ctl.paused = true;
      await new Promise((resolve) => { ctl.wake = resolve; });
      ctl.paused = false;
      ctl.wake = null;
      if (ctl.cancel) {
        finish(runId, 'cancelled', `Cancelled while paused before stage ${i + 1} of ${stages.length}`);
        return ran;
      }
    }

    // The outage this run answers may be over — the group it was started for is
    // back. Checked at the same boundary a cancel is, and for the same reason: a
    // stage already in flight is commands running on remote hosts. Stage 1 is
    // checked too, so a group that recovers between the trigger and the run
    // starting is never shut down at all.
    const back = recoveredFlatlineGroup(actionGroup, flatlineGroupId);
    if (back) {
      console.log(`[runs] "${actionGroup.name}" stopping before stage ${i + 1} — "${back.name}" recovered`);
      finish(runId, 'cancelled',
        `Stopped before stage ${i + 1} of ${stages.length} — "${back.name}" recovered`);
      return ran;
    }

    // 'pending' is a step whose batch has not started yet — everything below
    // the stage's next wait step.
    const steps = stage.steps.map((s) => ({
      name: s.target_id == null
        ? `wait ${s.wait_seconds}s`
        : store.getActionTarget(s.target_id)?.name ?? `deleted target ${s.target_id}`,
      state: 'pending'
    }));
    store.updateActionRun(runId, {
      status: 'running',
      stage_index: i,
      steps: JSON.stringify(steps),
      estimated_end_ts: Date.now() + remainingWorstCaseMs(stages, i),
      message: null
    });

    const { results, cancelled } = await runStage(runId, actionGroup, stage, steps, ctl);
    // Only what was actually acted on: a skipped (disabled) target was never
    // sent anything, so there is nothing to bring back.
    for (const r of results) if (r.target_id != null && !r.skipped) ran.add(r.target_id);
    if (cancelled) {
      finish(runId, 'cancelled', `Cancelled during stage ${i + 1} of ${stages.length}`);
      return ran;
    }

    // Skipped steps are left out of the verdict — a stage of nothing but
    // disabled targets has not failed, it simply had nothing to do.
    const attempted = results.filter((r) => !r.skipped);
    const failed = attempted.filter((r) => !r.ok).length;
    const stageFailed = stage.pass_rule === 'all'
      ? attempted.length > 0 && failed === attempted.length // every step in the stage failed
      : failed > 0;                                        // any step in the stage failed
    if (stageFailed) failedStages += 1;

    if (stageFailed && (stage.on_failure ?? actionGroup.on_failure) === 'stop') {
      console.log(`[runs] "${actionGroup.name}" stopping after stage ${i + 1} — ${failed}/${attempted.length} failed and on_failure is 'stop'`);
      finish(runId, 'failed',
        `Stopped after stage ${i + 1} of ${stages.length} — ${failed} of ${attempted.length} targets failed`);
      return ran;
    }
  }

  finish(runId, failedStages > 0 ? 'failed' : 'completed',
    failedStages > 0
      ? `Ran all ${stages.length} stage(s); ${failedStages} failed but the sequence continued`
      : `All ${stages.length} stage(s) completed`);
  return ran;
}

/**
 * Runs one stage, returning { results, cancelled }. `results` covers the steps
 * that actually started — the ones a cancel cut off are not in it.
 *
 * The stage's wait steps split its steps into batches: a batch starts together,
 * its wait is then held, and only then does the batch below it start. `steps` is
 * the progress array the dashboard reads, rewritten as each step lands.
 *
 * A cancel takes effect at those waits, where nothing is in flight, and nowhere
 * else: once a batch has started, its commands are running on remote hosts and
 * cannot be recalled. A pause is not honoured mid-stage at all — it holds at the
 * next stage boundary, as it always has.
 */
async function runStage(runId, actionGroup, stage, steps, ctl) {
  const results = [];
  const save = () => store.updateActionRun(runId, { steps: JSON.stringify(steps) });

  let batch = []; // indices of the steps waiting to start together
  const runBatch = async () => {
    if (batch.length === 0) return;
    for (const si of batch) steps[si].state = 'running';
    save();
    const started = batch;
    batch = [];
    results.push(...await Promise.all(started.map((si) =>
      runActionStep(actionGroup, stage.steps[si]).then((r) => {
        steps[si].state = r.skipped ? 'skipped' : r.ok ? 'ok' : 'failed';
        save();
        return r;
      }))));
  };

  for (let si = 0; si < stage.steps.length; si++) {
    const step = stage.steps[si];
    if (step.target_id != null) {
      batch.push(si);
      continue;
    }

    await runBatch();
    if (ctl.cancel) return { results, cancelled: true };

    // A cut-off wait is left mid-flight rather than marked done: it is exactly
    // where the run stopped, and the steps below it stay 'pending'.
    steps[si].state = 'running';
    save();
    console.log(`[runs] "${actionGroup.name}" holding stage open for ${step.wait_seconds}s`);
    await sleep(ctl, step.wait_seconds * 1000);
    if (ctl.cancel) return { results, cancelled: true };
    steps[si].state = 'ok';
    save();
  }

  await runBatch();
  return { results, cancelled: false };
}

/**
 * Waits, unless the run is cancelled first — this only ever covers a gap
 * between stages or a wait step inside one, where nothing has been sent to a
 * machine and there is nothing to let finish. Shares ctl.wake with the pause
 * hold: a run is only ever in one of them.
 */
function sleep(ctl, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ctl.wake = null; resolve(); }, ms);
    ctl.wake = () => { clearTimeout(timer); ctl.wake = null; resolve(); };
  });
}

/** Runs one step against its target and records the result. Returns
 *  { ok, skipped, target_id } — the id names what a later restore has to undo. */
async function runActionStep(actionGroup, step) {
  const target = store.getActionTarget(step.target_id);
  if (!target) {
    store.recordEvent({
      ts: Date.now(), kind: 'action_step_failed',
      message: `"${actionGroup.name}": step target ${step.target_id} no longer exists`
    });
    return { ok: false };
  }

  // A disabled target is out of the run entirely: nothing is sent to it, and
  // it counts neither as a success nor a failure when the stage is judged.
  if (!target.enabled) {
    store.recordEvent({
      ts: Date.now(), kind: 'action_step_skipped',
      message: `"${actionGroup.name}" -> ${target.name} (${target.kind}): skipped — this target is disabled`
    });
    console.log(`[runs] "${actionGroup.name}" -> ${target.name}: SKIPPED — target is disabled`);
    return { ok: true, skipped: true, target_id: target.id };
  }

  let config;
  try { config = JSON.parse(target.config); } catch { config = {}; }
  const secrets = decryptSecrets(target.secret_enc);

  let result;
  try {
    result = await runStep(target.kind, config, secrets, step.timeout_seconds * 1000);
  } catch (err) {
    result = { ok: false, message: err.message };
  }

  recordTargetActivity(target.id, result, 'run');
  store.recordEvent({
    ts: Date.now(),
    kind: result.ok ? 'action_step_ok' : 'action_step_failed',
    message: `"${actionGroup.name}" -> ${target.name} (${target.kind}): ${result.message}`
  });
  console.log(`[runs] "${actionGroup.name}" -> ${target.name}: ${result.ok ? 'OK' : 'FAILED'} — ${result.message}`);
  return { ok: result.ok, target_id: target.id };
}

// ---- controls ----
// Each returns an error string when the request doesn't apply, null on success.

export function pauseRun(id) {
  const ctl = controls.get(id);
  if (!ctl) return 'this run is no longer controllable';
  if (ctl.cancel) return 'this run is already cancelling';
  ctl.pause = true;
  return null;
}

export function resumeRun(id) {
  const ctl = controls.get(id);
  if (!ctl) return 'this run is no longer controllable';
  ctl.pause = false;
  // Only release an actual pause hold — ctl.wake may be a wait between stages,
  // and resuming a run that was never paused must not cut that wait short.
  if (ctl.paused) ctl.wake();
  return null;
}

export function cancelRun(id) {
  const ctl = controls.get(id);
  if (!ctl) return 'this run is no longer controllable';
  ctl.cancel = true;
  if (ctl.wake) ctl.wake(); // release a paused run, or a wait between stages
  return null;
}

/**
 * Runs for the dashboard. `controllable` says whether Pause/Cancel will do
 * anything; `pause_requested` covers the window where a pause was asked for but
 * the current stage is still finishing.
 */
export function publicRun(run) {
  const ctl = controls.get(run.id);
  let steps = [];
  try { steps = JSON.parse(run.steps); } catch { steps = []; }
  return {
    id: run.id,
    action_group_id: run.action_group_id,
    action_group_name: run.action_group_name,
    trigger: run.trigger,
    trigger_detail: run.trigger_detail,
    status: run.status,
    stage_index: run.stage_index,
    stage_count: run.stage_count,
    steps,
    started_at: run.started_at,
    estimated_end_ts: run.estimated_end_ts,
    ended_at: run.ended_at,
    message: run.message,
    controllable: !!ctl,
    pause_requested: !!ctl?.pause,
    cancel_requested: !!ctl?.cancel
  };
}
