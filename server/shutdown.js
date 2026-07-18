import * as store from './db.js';
import { decryptSecrets } from './secrets.js';
import { runStep } from './connectors.js';
import { recordTargetActivity } from './targetHealth.js';

/**
 * Watches each enabled Flatline group. A group "fails" when its endpoints are
 * down per the group's mode ('all' = every endpoint down, 'any' = at least
 * one). A failed group arms its own countdown; if it stays failed past the
 * group's grace period, its assigned action groups trigger.
 *
 * The actual action execution is deliberately a stub for now — see
 * triggerActions() — the connectors (SSH/RDP/K8s/HTTP) come in a later phase.
 */

const EVAL_INTERVAL_MS = 5000;

/** group id -> { armed, outageStartTs, deadlineTs, triggered, triggeredTs } */
const states = new Map();

export function startShutdownWatcher() {
  setInterval(evaluate, EVAL_INTERVAL_MS);
}

/** Per-group countdown state for the dashboard. */
export function getGroupStates() {
  const endpoints = store.listEndpoints();
  const actionGroups = store.listActionGroups();

  return store.listFlatlineGroups().map((g) => {
    const members = endpoints.filter((e) => e.group_ids.includes(g.id) && e.enabled);
    const st = states.get(g.id);
    return {
      group_id: g.id,
      name: g.name,
      mode: g.mode,
      enabled: g.enabled,
      grace_minutes: g.grace_minutes,
      endpoint_count: members.length,
      down_count: members.filter((e) => e.last_state === 'down').length,
      action_group_names: g.action_group_ids
        .map((id) => actionGroups.find((ag) => ag.id === id)?.name)
        .filter(Boolean),
      armed: st?.armed ?? false,
      outage_start_ts: st?.outageStartTs ?? null,
      deadline_ts: st?.deadlineTs ?? null,
      triggered: st?.triggered ?? false,
      triggered_ts: st?.triggeredTs ?? null
    };
  });
}

function evaluate() {
  const now = Date.now();
  const groups = store.listFlatlineGroups();
  const endpoints = store.listEndpoints();
  const liveIds = new Set();

  for (const g of groups) {
    liveIds.add(g.id);
    const st = states.get(g.id) ?? {
      armed: false, outageStartTs: null, deadlineTs: null, triggered: false, triggeredTs: null
    };
    states.set(g.id, st);

    const members = endpoints.filter((e) => e.group_ids.includes(g.id) && e.enabled);
    const downMembers = members.filter((e) => e.last_state === 'down');
    const failed = g.enabled && members.length > 0 && (
      g.mode === 'any' ? downMembers.length > 0 : downMembers.length === members.length
    );

    if (!failed) {
      if (st.armed) {
        const wasTriggered = st.triggered;
        st.armed = false;
        st.outageStartTs = null;
        st.deadlineTs = null;
        st.triggered = false;
        st.triggeredTs = null;
        store.recordEvent({
          ts: now, kind: 'shutdown_disarmed',
          message: `Group "${g.name}" recovered ${wasTriggered ? 'after actions triggered' : 'before grace period elapsed'}`
        });
        console.log(`[watcher] "${g.name}" disarmed — group recovered`);
      }
      continue;
    }

    // Failure began when the most recent qualifying endpoint flipped down.
    const relevant = g.mode === 'any' ? downMembers : members;
    const start = Math.max(...relevant.map((e) => e.last_change_ts ?? now));

    if (!st.armed) {
      st.armed = true;
      st.outageStartTs = start;
      store.recordEvent({
        ts: now, kind: 'shutdown_armed',
        message: `Group "${g.name}" failed (${downMembers.length}/${members.length} down) — actions in ${g.grace_minutes} min unless it recovers`
      });
      console.log(`[watcher] "${g.name}" armed`);
    }
    // Recomputed every pass so live edits to the grace period take effect.
    st.deadlineTs = st.outageStartTs + g.grace_minutes * 60_000;

    if (!st.triggered && now >= st.deadlineTs) {
      st.triggered = true;
      st.triggeredTs = now;
      triggerActions(g, now).catch((err) => console.error(`[watcher] "${g.name}" trigger failed unexpectedly:`, err));
    }
  }

  for (const id of states.keys()) {
    if (!liveIds.has(id)) states.delete(id);
  }
}

async function triggerActions(group, now) {
  const actionGroups = store.listActionGroups().filter((ag) => group.action_group_ids.includes(ag.id) && ag.enabled);
  const names = actionGroups.map((ag) => ag.name);
  store.recordEvent({
    ts: now, kind: 'shutdown_triggered',
    message: `Group "${group.name}" grace period elapsed — running action group(s): ${names.length ? names.join(', ') : '(none assigned)'}`
  });
  console.log(`[watcher] "${group.name}" TRIGGERED — running: ${names.join(', ') || '(none)'}`);

  for (const ag of actionGroups) {
    await runActionGroup(ag);
  }
}

/** Runs an action group's steps in order, honoring its on_failure policy. */
async function runActionGroup(actionGroup) {
  for (const step of actionGroup.steps) {
    const target = store.getActionTarget(step.target_id);
    if (!target) {
      store.recordEvent({
        ts: Date.now(), kind: 'action_step_failed',
        message: `"${actionGroup.name}": step target ${step.target_id} no longer exists`
      });
      if (actionGroup.on_failure === 'stop') return;
      continue;
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
    console.log(`[watcher] "${actionGroup.name}" -> ${target.name}: ${result.ok ? 'OK' : 'FAILED'} — ${result.message}`);

    if (!result.ok && actionGroup.on_failure === 'stop') {
      console.log(`[watcher] "${actionGroup.name}" stopping — step failed and on_failure is 'stop'`);
      return;
    }
  }
}
