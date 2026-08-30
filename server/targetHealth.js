import * as store from './db.js';
import { decryptSecrets } from './secrets.js';
import { testTarget, testSendsRealAction } from './connectors.js';

/**
 * Background connectivity check for action targets — the same safe test the
 * "Test connection" button runs, just on a timer, so the targets table shows
 * a live status dot without the user having to open each one.
 *
 * Two cadences, because a check is not free: every one is a real connection to
 * a real machine — an SSH handshake, a WinRM auth — that the target has to
 * service, and its logs will show. So the fast cadence runs only while a page
 * is actually watching the dots, and the moment nothing is, it drops back to
 * the interval it always used. Nobody needs ten-second resolution on a dot at
 * three in the morning with no browser open.
 */

const IDLE_INTERVAL_MS = 60_000;
const WATCHED_INTERVAL_MS = 10_000;

/** target id -> { ok, message, checkedAt } — background connectivity poll only. */
const health = new Map();

let timer = null;
let watching = false;
let lastPassAt = 0;
// When the last pass included the targets that are held back from fast passes.
let lastFullPassAt = 0;

export function startTargetHealthPoller() {
  schedule(0);
}

function schedule(delay = watching ? WATCHED_INTERVAL_MS : IDLE_INTERVAL_MS) {
  clearTimeout(timer);
  // Re-armed after each pass finishes rather than on a fixed interval: one pass
  // can take up to the connector's test timeout, which is close enough to the
  // fast cadence that a fixed interval would let passes overlap.
  timer = setTimeout(() => void checkAll().finally(() => schedule()), delay);
}

/**
 * Tells the poller whether anyone is looking at the dots (see the event stream
 * in server/index.js). Switching it on refreshes them straight away, so opening
 * a page does not greet you with dots up to a minute old.
 */
export function setWatched(value) {
  if (value === watching) return;
  watching = value;
  if (!value) {
    schedule();
    return;
  }
  // Unless a pass has only just run: reloading a page repeatedly must not turn
  // into a burst of connections to every machine.
  schedule(Math.max(0, WATCHED_INTERVAL_MS - (Date.now() - lastPassAt)));
}

/**
 * Called with (id, health) when a target's connectivity flips, so the pages
 * watching can be told at once instead of waiting for their own next poll.
 *
 * Deliberately not an entry in the events table: this is a dot changing colour,
 * not something that happened to the infrastructure, and the events feed is a
 * log of the latter.
 */
let onChange = null;
export function onHealthChange(cb) {
  onChange = cb;
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

// A restore that is still running. The manual Restore route answers 202 and
// leaves the sequence going, because waiting for a host to boot or a cluster's
// API server to answer takes minutes — this is what the page shows meanwhile.
// In memory only: an interrupted restore is not resumable, so a restart should
// forget it rather than leave a phase on screen that nothing is working on.
// target id -> { phase, since, startedAt }
const restoring = new Map();

export function getRestoreProgress(id) {
  return restoring.get(id) ?? null;
}

/**
 * Marks a restore as running and returns the phase reporter to hand to
 * restoreStep. Call endRestore() when it settles, whichever way it went.
 */
export function beginRestore(id) {
  const now = Date.now();
  restoring.set(id, { phase: 'starting', since: now, startedAt: now });
  return (phase) => {
    const current = restoring.get(id);
    if (current) restoring.set(id, { ...current, phase, since: Date.now() });
  };
}

export function endRestore(id) {
  restoring.delete(id);
}

export function isRestoring(id) {
  return restoring.has(id);
}

/** Re-checks one target immediately (e.g. right after it's created/edited) rather than waiting for the next tick. */
export async function checkTargetNow(id) {
  const target = store.getActionTarget(id);
  if (!target) return;
  await checkOne(target);
}

function parseConfig(target) {
  try { return JSON.parse(target.config); } catch { return {}; }
}

async function checkAll() {
  const now = Date.now();
  lastPassAt = now;
  // A target whose test sends its real action is never checked on the fast
  // cadence — watching a dot must not mean firing someone's shutdown request
  // six times a minute. Those stay on the interval they always had.
  const full = !watching || now - lastFullPassAt >= IDLE_INTERVAL_MS;
  if (full) lastFullPassAt = now;

  const due = store.listActionTargets().filter((t) =>
    t.enabled && (full || !testSendsRealAction(t.kind, parseConfig(t))));
  await Promise.all(due.map(checkOne));

  const liveIds = new Set(store.listActionTargets().map((t) => t.id));
  for (const id of health.keys()) {
    if (!liveIds.has(id)) health.delete(id);
  }
}

async function checkOne(target) {
  const config = parseConfig(target);
  const secrets = decryptSecrets(target.secret_enc);

  let next;
  try {
    const result = await testTarget(target.kind, config, secrets);
    next = { ok: result.ok, message: result.message, checkedAt: Date.now() };
  } catch (err) {
    next = { ok: false, message: err.message, checkedAt: Date.now() };
  }

  const prev = health.get(target.id);
  health.set(target.id, next);
  // Only a flip is worth waking a page for. Re-confirming the same state changes
  // nothing on screen but the timestamp behind the dot.
  if (prev?.ok !== next.ok) onChange?.(target.id, next);
}
