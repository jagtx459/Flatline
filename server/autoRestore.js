import * as store from './db.js';
import { decryptSecrets } from './secrets.js';
import { restoreStep } from './connectors.js';
import { recordTargetActivity } from './targetHealth.js';

/**
 * Brings targets back once a Flatline group that had already triggered its
 * actions reports healthy again. shutdown.js decides when this happens — this
 * file decides what comes back, and in what order.
 *
 * Only targets with auto-restore ticked take part, and they are walked in the
 * reverse of the order they went down in: the group's action groups back to
 * front, their stages back to front, and the steps within a stage back to
 * front. Targets that went down together come back together.
 *
 * Ordering here only decides who is asked first. What actually holds a machine
 * behind the one it depends on is each target's own restore sequence, which
 * waits for the host — or, for k8s, the cluster's API server — to answer before
 * running its final step (see connectors.js restoreSequence / restoreK8s).
 */

/** Kinds that offer an auto-restore tick box, and so can take part here. */
const AUTO_RESTORE_KINDS = ['ssh', 'winrm', 'k8s'];

/** Group ids with an auto-restore in flight — a restore outlasts the 5s
 *  watcher tick by minutes, and a group that flaps must not start a second. */
const inFlight = new Set();

function parseConfig(target) {
  try { return JSON.parse(target.config); } catch { return {}; }
}

/**
 * Loads and decrypts the relay a target wakes through, or null when it does not
 * use one (or the relay has since been deleted or disabled — restoreStep says
 * so plainly rather than skipping the wake in silence).
 *
 * Exported because the manual Restore route needs exactly the same lookup:
 * connectors.js never touches the database, so whoever calls it resolves this.
 */
export function resolveWakeRelay(config) {
  if (config.wake_mode !== 'relay' || config.wake_relay_id == null) return null;
  const relay = store.getRelay(config.wake_relay_id);
  if (!relay || !relay.enabled) return null;

  let relayConfig;
  try { relayConfig = JSON.parse(relay.config); } catch { relayConfig = {}; }
  return {
    name: relay.name,
    kind: relay.kind,
    config: relayConfig,
    secrets: decryptSecrets(relay.secret_enc),
    wake_command: relay.wake_command
  };
}

/** The auto-restore targets of one action group, as the batches that come back
 *  together: stages back to front, steps within a stage back to front. */
function restoreBatches(actionGroup) {
  const batches = [];
  for (const stage of [...(actionGroup.stages ?? [])].reverse()) {
    const batch = [];
    for (const step of [...stage.steps].reverse()) {
      if (step.target_id == null) continue; // a wait on the way down — nothing to undo
      const target = store.getActionTarget(step.target_id);
      if (!target?.enabled) continue;
      if (!AUTO_RESTORE_KINDS.includes(target.kind)) continue;
      const config = parseConfig(target);
      if (!config.auto_restore) continue;
      batch.push({ target, config });
    }
    if (batch.length) batches.push(batch);
  }
  return batches;
}

/**
 * Restores everything the given Flatline group brought down that asked to come
 * back. A target reused across stages or action groups is restored once, at
 * the first point the reverse walk reaches it.
 */
export async function runAutoRestore(group) {
  if (inFlight.has(group.id)) {
    console.log(`[restore] "${group.name}" recovered again while an auto-restore was still running — ignored`);
    return;
  }

  const actionGroups = store.listActionGroups()
    .filter((ag) => group.action_group_ids.includes(ag.id) && ag.enabled);

  const seen = new Set();
  const batches = [];
  for (const ag of [...actionGroups].reverse()) {
    for (const batch of restoreBatches(ag)) {
      const fresh = batch.filter(({ target }) => !seen.has(target.id));
      for (const { target } of fresh) seen.add(target.id);
      if (fresh.length) batches.push(fresh);
    }
  }
  if (batches.length === 0) return;

  inFlight.add(group.id);
  console.log(`[restore] "${group.name}" recovered — auto-restoring ${seen.size} target(s)`);
  try {
    for (const batch of batches) {
      await Promise.all(batch.map(({ target, config }) => restoreOne(group, target, config)));
    }
  } finally {
    inFlight.delete(group.id);
  }
}

/** Runs one target's restore sequence, recording it the same way a triggered
 *  action step is recorded — so it lands in the event feed and notifications
 *  without a channel having to subscribe to anything new. */
async function restoreOne(group, target, config) {
  const secrets = decryptSecrets(target.secret_enc);

  let result;
  try {
    result = await restoreStep(target.kind, config, secrets, undefined, resolveWakeRelay(config));
  } catch (err) {
    result = { ok: false, message: err.message };
  }

  recordTargetActivity(target.id, result, 'restore');
  store.recordEvent({
    ts: Date.now(),
    kind: result.ok ? 'action_step_ok' : 'action_step_failed',
    message: `Auto-restore after "${group.name}" recovered -> ${target.name} (${target.kind}): ${result.message}`
  });
  console.log(`[restore] "${group.name}" -> ${target.name}: ${result.ok ? 'OK' : 'FAILED'} — ${result.message}`);
}
