import * as store from './db.js';
import { decryptSecrets } from './secrets.js';
import { testTarget } from './connectors.js';

/**
 * Background connectivity check for action targets — the same safe test the
 * "Test connection" button runs, just on a timer, so the targets table shows
 * a live status dot without the user having to open each one. RDP is skipped
 * entirely (execution isn't implemented, so it would just show permanently
 * red for no useful reason).
 */

const CHECK_INTERVAL_MS = 60_000;

/** target id -> { ok, message, checkedAt } — background connectivity poll only. */
const health = new Map();

export function startTargetHealthPoller() {
  setInterval(() => void checkAll(), CHECK_INTERVAL_MS);
  void checkAll();
}

export function getTargetHealth(id) {
  return health.get(id) ?? null;
}

// Manual activity (Test/Run/Restore) — separate from the background poll
// above, so a paused target that's still manually tested keeps its own
// history instead of being silently skipped like the auto-poll skips it.
// target id -> { ok, message, ts, trigger: 'test' | 'run' | 'restore' }
const activity = new Map();

export function getTargetActivity(id) {
  return activity.get(id) ?? null;
}

export function clearTargetActivity(id) {
  activity.delete(id);
}

export function recordTargetActivity(id, result, trigger) {
  if (!Number.isInteger(id)) return;
  activity.set(id, { ok: result.ok, message: result.message, ts: Date.now(), trigger });
}

/** Re-checks one target immediately (e.g. right after it's created/edited) rather than waiting for the next tick. */
export async function checkTargetNow(id) {
  const target = store.getActionTarget(id);
  if (!target) return;
  await checkOne(target);
}

async function checkAll() {
  const targets = store.listActionTargets().filter((t) => t.enabled && t.kind !== 'rdp');
  await Promise.all(targets.map(checkOne));

  const liveIds = new Set(store.listActionTargets().map((t) => t.id));
  for (const id of health.keys()) {
    if (!liveIds.has(id)) health.delete(id);
  }
}

async function checkOne(target) {
  if (target.kind === 'rdp') return;
  let config;
  try { config = JSON.parse(target.config); } catch { config = {}; }
  const secrets = decryptSecrets(target.secret_enc);

  try {
    const result = await testTarget(target.kind, config, secrets);
    health.set(target.id, { ok: result.ok, message: result.message, checkedAt: Date.now() });
  } catch (err) {
    health.set(target.id, { ok: false, message: err.message, checkedAt: Date.now() });
  }
}
