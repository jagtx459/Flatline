import { runCheck } from './checks.js';
import * as store from './db.js';

/** endpoint id -> { timer, consecOk, consecFail, busy } */
const runtimes = new Map();

export function startPoller() {
  reschedule();
}

/** Clears all timers and re-schedules from the current endpoint config. Call after any CRUD. */
export function reschedule() {
  for (const rt of runtimes.values()) {
    if (rt.timer) clearInterval(rt.timer);
  }

  const endpoints = store.listEndpoints();
  const liveIds = new Set();

  for (const ep of endpoints) {
    if (!ep.enabled) continue;
    liveIds.add(ep.id);
    const rt = runtimes.get(ep.id) ?? { timer: null, consecOk: 0, consecFail: 0, busy: false };
    runtimes.set(ep.id, rt);

    const intervalMs = Math.max(5, ep.interval_seconds) * 1000;
    // Small random offset so endpoints with the same interval don't fire in lockstep.
    const jitter = Math.floor(Math.random() * Math.min(2000, intervalMs / 2));
    rt.timer = setInterval(() => void tick(ep.id), intervalMs);
    setTimeout(() => void tick(ep.id), jitter);
  }

  for (const [id, rt] of runtimes) {
    if (!liveIds.has(id)) {
      if (rt.timer) clearInterval(rt.timer);
      runtimes.delete(id);
    }
  }
}

async function tick(endpointId) {
  const rt = runtimes.get(endpointId);
  if (!rt || rt.busy) return;

  const ep = store.getEndpoint(endpointId);
  if (!ep || !ep.enabled) return;

  rt.busy = true;
  try {
    const result = await runCheck(ep);
    store.recordCheck(ep.id, result);
    applyResult(ep, rt, result);
  } catch (err) {
    console.error(`[poller] check failed unexpectedly for endpoint ${endpointId}:`, err);
  } finally {
    rt.busy = false;
  }
}

function applyResult(ep, rt, result) {
  if (result.ok) {
    rt.consecOk += 1;
    rt.consecFail = 0;
  } else {
    rt.consecFail += 1;
    rt.consecOk = 0;
    // Surface every failed check in the container logs (state transitions are
    // logged separately below); repeats while down make the outage visible.
    console.warn(`[poller] ${ep.name} check failed (${rt.consecFail}x): ${result.error ?? 'no response'}`);
  }

  let next = null;
  if (ep.last_state === 'unknown') {
    // First observation decides immediately; thresholds only guard transitions.
    next = result.ok ? 'up' : 'down';
  } else if (ep.last_state === 'down' && rt.consecOk >= ep.up_threshold) {
    next = 'up';
  } else if (ep.last_state === 'up' && rt.consecFail >= ep.down_threshold) {
    next = 'down';
  }

  if (next && next !== ep.last_state) {
    store.setEndpointState(ep.id, next, result.ts);
    store.recordEvent({
      ts: result.ts,
      endpointId: ep.id,
      kind: 'state',
      fromState: ep.last_state,
      toState: next,
      message: result.error ?? null
    });
    console.log(`[poller] ${ep.name}: ${ep.last_state} -> ${next}${result.error ? ` (${result.error})` : ''}`);
  }
}
