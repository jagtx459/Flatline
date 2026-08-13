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
 * Executing those action groups is actionRuns.js's job — this file only
 * decides when they start.
 */

const EVAL_INTERVAL_MS = 5000;

/** group id -> { armed, outageStartTs, deadlineTs, triggered, triggeredTs } */
const states = new Map();

/** Returns the interval so tests can stop the watcher; the server ignores it. */
export function startShutdownWatcher() {
  return setInterval(evaluate, EVAL_INTERVAL_MS);
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

        // Only worth undoing if the actions actually ran. Deliberately not
        // awaited: a restore waits minutes for hosts to boot, and the watcher
        // has every other group to keep evaluating meanwhile.
        if (wasTriggered) {
          runAutoRestore(g).catch((err) =>
            console.error(`[restore] "${g.name}" auto-restore failed unexpectedly:`, err));
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

  // Sequential, as before: one action group's stages finish before the next
  // starts. A paused run therefore holds the ones behind it, which is the
  // point of pausing.
  for (const ag of actionGroups) {
    const { done } = startActionGroupRun(ag, { trigger: 'flatline', detail: group.name });
    await done;
  }
}
