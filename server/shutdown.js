import * as store from './db.js';
import { startActionGroupRun } from './actionRuns.js';
import { runAutoRestore } from './autoRestore.js';

/**
 * Watches each enabled Flatline group. A group "fails" when its endpoints are
 * down per the group's mode ('all' = every endpoint down, 'any' = at least
 * one). A failed group arms its own countdown; if it stays failed past the
 * group's grace period, its assigned action groups trigger. A group that
 * recovers after triggering hands off to autoRestore.js to bring back the
 * targets that asked for it.
 *
 * An action group set to stop_on_restore stops itself on that recovery rather
 * than running its remaining stages (actionRuns.js does that). Its restore then
 * waits for it: only once the run has stopped is it known which targets were
 * actually acted on, and the ones it never reached must not be restored from a
 * state they were never put in.
 *
 * Executing those action groups is actionRuns.js's job — this file only
 * decides when they start.
 */

const EVAL_INTERVAL_MS = 5000;

/**
 * group id -> { armed, outageStartTs, deadlineTs, triggered, triggeredTs,
 *   trigger, ranTargets, stopsOnRestore, restoreWhenDone }
 *
 * The last four cover one trigger: a marker for it while its action groups are
 * still running, the targets they have acted on so far, whether any of them
 * stops when the group comes back, and whether a recovery arrived before they
 * had finished.
 */
const states = new Map();

/** Returns the interval so tests can stop the watcher; the server ignores it. */
export function startShutdownWatcher() {
  return setInterval(evaluate, EVAL_INTERVAL_MS);
}

/**
 * Evaluates now instead of waiting out the interval.
 *
 * An endpoint changing state is the only input that can arm or disarm a group,
 * so the server reacts to one the moment the poller reports it. Without this a
 * banner trails the outage that caused it by up to EVAL_INTERVAL_MS, on top of
 * however long the page then takes to notice. Safe to call from an event hook:
 * evaluate never records a 'state' event, so it cannot re-enter through the
 * subscriber that calls this.
 */
export function evaluateNow() {
  evaluate();
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
      armed: false, outageStartTs: null, deadlineTs: null, triggered: false, triggeredTs: null,
      trigger: null, ranTargets: new Set(), stopsOnRestore: false, restoreWhenDone: false
    };
    states.set(g.id, st);

    const members = endpoints.filter((e) => e.group_ids.includes(g.id) && e.enabled);
    const downMembers = members.filter((e) => e.last_state === 'down');
    const failed = g.enabled && store.isFlatlineGroupDown(g, endpoints);

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

        // Only worth undoing if the actions actually ran.
        if (wasTriggered && st.stopsOnRestore && st.trigger) {
          // Those runs are stopping on this very recovery. What they got as far
          // as is only settled once they have, so the restore waits for them —
          // see finishTrigger.
          st.restoreWhenDone = true;
          console.log(`[watcher] "${g.name}" recovered mid-run — restoring once the run stops`);
        } else if (wasTriggered) {
          // A trigger that stops on restore reports exactly what it acted on;
          // any other one is restored whole, as it always has been.
          autoRestore(g, st.stopsOnRestore ? st.ranTargets : null);
        }
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
      st.ranTargets = new Set();
      st.stopsOnRestore = false;
      st.restoreWhenDone = false;
      // Identifies this trigger, so a group that flaps hard enough to start a
      // second one cannot have the first's completion mistaken for its own.
      const token = {};
      st.trigger = token;
      triggerActions(g, now, st)
        .catch((err) => console.error(`[watcher] "${g.name}" trigger failed unexpectedly:`, err))
        .finally(() => finishTrigger(g.id, token));
    }
  }

  for (const id of states.keys()) {
    if (!liveIds.has(id)) states.delete(id);
  }
}

async function triggerActions(group, now, st) {
  const actionGroups = store.listActionGroups().filter((ag) => group.action_group_ids.includes(ag.id) && ag.enabled);
  st.stopsOnRestore = actionGroups.some((ag) => ag.stop_on_restore);
  const names = actionGroups.map((ag) => ag.name);
  store.recordEvent({
    ts: now, kind: 'shutdown_triggered',
    message: `Group "${group.name}" grace period elapsed — running action group(s): ${names.length ? names.join(', ') : '(none assigned)'}`
  });
  console.log(`[watcher] "${group.name}" TRIGGERED — running: ${names.join(', ') || '(none)'}`);

  // Sequential, as before: one action group's stages finish before the next
  // starts. A paused run therefore holds the ones behind it, which is the
  // point of pausing.
  for (const ag of actionGroups) {
    const { done } = startActionGroupRun(ag,
      { trigger: 'flatline', detail: group.name, flatlineGroupId: group.id });
    for (const targetId of await done) st.ranTargets.add(targetId);
  }
}

/**
 * The trigger's runs are all over. A recovery that arrived while they were
 * still going left its restore for this moment — unless the group has gone down
 * again since, in which case there is nothing to bring anything back to.
 */
function finishTrigger(groupId, token) {
  const st = states.get(groupId);
  if (!st || st.trigger !== token) return; // a newer trigger has taken over
  st.trigger = null;
  if (!st.restoreWhenDone) return;
  st.restoreWhenDone = false;

  const group = store.getFlatlineGroup(groupId);
  if (group && !store.isFlatlineGroupDown(group)) autoRestore(group, st.ranTargets);
}

/** Deliberately not awaited: a restore waits minutes for hosts to boot, and the
 *  watcher has every other group to keep evaluating meanwhile. */
function autoRestore(group, only) {
  runAutoRestore(group, only).catch((err) =>
    console.error(`[restore] "${group.name}" auto-restore failed unexpectedly:`, err));
}
