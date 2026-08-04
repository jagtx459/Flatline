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
    console.log(`[runs] run ${run.id} ("${run.action_group_name}") marked interrupted`);
  }
}

/** Worst case for a stage: its steps run at once, so the slowest timeout wins. */
function stageWorstCaseMs(stage) {
  return Math.max(...stage.steps.map((s) => s.timeout_seconds)) * 1000;
}

function remainingWorstCaseMs(stages, fromIndex) {
  return stages.slice(fromIndex).reduce((ms, st) => ms + stageWorstCaseMs(st), 0);
}

export function isRunning(actionGroupId) {
  return store.listLiveActionRuns().some((r) => r.action_group_id === actionGroupId);
}

/**
 * Starts an action group. Returns { run, done } — `run` is the row as created
 * (so a caller can respond immediately) and `done` resolves when the run
 * finishes, for callers that need the stages to complete before moving on.
 */
export function startActionGroupRun(actionGroup, { trigger, detail = null }) {
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

  controls.set(run.id, { pause: false, cancel: false, wake: null });
  const done = execute(run.id, actionGroup, stages)
    .catch((err) => {
      console.error(`[runs] run ${run.id} ("${actionGroup.name}") failed unexpectedly:`, err);
      finish(run.id, 'failed', `Run failed unexpectedly: ${err.message}`);
    })
    .finally(() => controls.delete(run.id));

  return { run, done };
}

function finish(runId, status, message) {
  store.updateActionRun(runId, {
    status, message, ended_at: Date.now(), estimated_end_ts: null
  });
}

async function execute(runId, actionGroup, stages) {
  const ctl = controls.get(runId);

  if (stages.length === 0) {
    finish(runId, 'completed', 'Nothing to do — this action group has no stages');
    return;
  }

  let failedStages = 0;

  for (let i = 0; i < stages.length; i++) {
    if (ctl.cancel) {
      finish(runId, 'cancelled', `Cancelled before stage ${i + 1} of ${stages.length}`);
      return;
    }
    if (ctl.pause) {
      store.updateActionRun(runId, {
        status: 'paused',
        estimated_end_ts: null,
        message: `Paused before stage ${i + 1} of ${stages.length}`
      });
      console.log(`[runs] run ${runId} ("${actionGroup.name}") paused before stage ${i + 1}`);
      await new Promise((resolve) => { ctl.wake = resolve; });
      ctl.wake = null;
      if (ctl.cancel) {
        finish(runId, 'cancelled', `Cancelled while paused before stage ${i + 1} of ${stages.length}`);
        return;
      }
    }

    const stage = stages[i];
    const steps = stage.steps.map((s) => ({
      name: store.getActionTarget(s.target_id)?.name ?? `deleted target ${s.target_id}`,
      state: 'running'
    }));
    store.updateActionRun(runId, {
      status: 'running',
      stage_index: i,
      steps: JSON.stringify(steps),
      estimated_end_ts: Date.now() + remainingWorstCaseMs(stages, i),
      message: null
    });

    const results = await Promise.all(stage.steps.map((step, si) =>
      runActionStep(actionGroup, step).then((r) => {
        steps[si].state = r.ok ? 'ok' : 'failed';
        store.updateActionRun(runId, { steps: JSON.stringify(steps) });
        return r;
      })));

    const failed = results.filter((r) => !r.ok).length;
    const stageFailed = stage.pass_rule === 'all'
      ? results.length > 0 && failed === results.length // every step in the stage failed
      : failed > 0;                                     // any step in the stage failed
    if (stageFailed) failedStages += 1;

    if (stageFailed && (stage.on_failure ?? actionGroup.on_failure) === 'stop') {
      console.log(`[runs] "${actionGroup.name}" stopping after stage ${i + 1} — ${failed}/${results.length} failed and on_failure is 'stop'`);
      finish(runId, 'failed',
        `Stopped after stage ${i + 1} of ${stages.length} — ${failed} of ${results.length} targets failed`);
      return;
    }
  }

  finish(runId, failedStages > 0 ? 'failed' : 'completed',
    failedStages > 0
      ? `Ran all ${stages.length} stage(s); ${failedStages} failed but the sequence continued`
      : `All ${stages.length} stage(s) completed`);
}

/** Runs one step against its target and records the result. Returns { ok }. */
async function runActionStep(actionGroup, step) {
  const target = store.getActionTarget(step.target_id);
  if (!target) {
    store.recordEvent({
      ts: Date.now(), kind: 'action_step_failed',
      message: `"${actionGroup.name}": step target ${step.target_id} no longer exists`
    });
    return { ok: false };
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
  return { ok: result.ok };
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
  if (ctl.wake) ctl.wake();
  return null;
}

export function cancelRun(id) {
  const ctl = controls.get(id);
  if (!ctl) return 'this run is no longer controllable';
  ctl.cancel = true;
  if (ctl.wake) ctl.wake(); // release a paused run so it can record the cancel
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
