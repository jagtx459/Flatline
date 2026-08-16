import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockTargets, SCENARIO } from './mock-targets.js';
import { startK3sCluster, stopK3sCluster, dockerUnavailable, DEV_CLUSTER, K3S_TAG } from './k3s-cluster.js';

/**
 * Local development entry point (`npm run dev`).
 *
 * Runs the app against its own throwaway database in data/dev, with mock
 * targets and demo data so every screen has something real on it. Never touches
 * the production data dir unless FLATLINE_DATA_DIR says so.
 *
 *   npm run dev                         a quiet instance to click around in —
 *                                       everything reports healthy and stays that way
 *   npm run dev:tests                   also drive the scripted outage on a loop, so
 *                                       groups arm, fire their actions, and recover
 *   node dev/start.js --tests --reseed  same, on fresh demo data
 *   node dev/start.js --reset           wipe it back to a factory state instead
 *
 * --tests and --reseed combine freely. --reset is the opposite of seeding and
 * combines with neither. Call this file directly to pass them; through npm they
 * need the `--` separator (`npm run dev -- --reseed`), since npm rejects any
 * flag it doesn't recognise as one of its own.
 *
 * Seeding will bring up a real single-node k3s cluster in Docker when Docker is
 * running, so the Kubernetes target on the Actions page has something to drain.
 * It is kept between restarts and removed by --reset. Without Docker the seed is
 * exactly what it always was.
 *
 * For pass/fail assertions use `npm run tests` instead — this script is the live
 * instance, not the checker.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = Number(process.env.FLATLINE_MOCK_PORT ?? 3198);

// Something for the drain to actually evict, and a DaemonSet to show the pod
// that comes straight back. Applied on every seed: `kubectl apply` is
// idempotent, so a reused cluster just keeps what it has.
//
// Declared up here, not with provisionDevCluster at the foot of the file: the
// seeding below is top-level code, and a `const` further down would still be in
// its temporal dead zone by the time that runs.
const DEV_WORKLOAD = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: demo-web }
spec:
  replicas: 2
  selector: { matchLabels: { app: demo-web } }
  template:
    metadata: { labels: { app: demo-web } }
    spec:
      terminationGracePeriodSeconds: 5
      containers:
        - name: pause
          image: rancher/mirrored-pause:3.6
---
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: demo-agent }
spec:
  selector: { matchLabels: { app: demo-agent } }
  template:
    metadata: { labels: { app: demo-agent } }
    spec:
      containers:
        - name: pause
          image: rancher/mirrored-pause:3.6
`;

const args = process.argv.slice(2);
const reseed = args.includes('--reseed');
const driveOutage = args.includes('--tests');
const reset = args.includes('--reset');

// Refused rather than resolved in some order: one of these empties the instance
// and the others fill it, so any combination is a mistake about what was wanted.
if (reset && (reseed || driveOutage)) {
  const clash = [reseed && '--reseed', driveOutage && '--tests'].filter(Boolean).join(' and ');
  console.error(`[dev] --reset cannot be combined with ${clash}.`);
  console.error('[dev] --reset wipes the database back to a factory state; the others fill it with demo data and drive it.');
  process.exit(1);
}

process.env.FLATLINE_DATA_DIR ??= path.join(__dirname, '..', 'data', 'dev');
process.env.PORT ??= '3131';

await startMockTargets(MOCK_PORT, {
  scenario: driveOutage,
  onPhase: (step) => console.log(`[dev] scenario: ${step.state.toUpperCase()} for ${step.seconds}s — ${step.note}`)
});
console.log(`[dev] mock targets on http://127.0.0.1:${MOCK_PORT} (/up /down /slow /hang /scenario)`);

if (driveOutage) {
  const cycle = SCENARIO.reduce((s, p) => s + p.seconds, 0);
  console.log(`[dev] --tests: outage scenario loops every ${cycle}s — "UPS management" and "Lab API" follow it`);
  console.log('[dev] --tests: each completed run is checked against the waits its stages ask for');
} else {
  console.log('[dev] all endpoints stay healthy — pass --tests to drive the scripted outage');
}

// After the env vars above — db.js opens its file the moment it's imported.
const store = await import('../server/db.js');
const { seedDemoData } = await import('./seed.js');

if (reset) {
  store.resetAll();
  const removed = await stopK3sCluster({ container: DEV_CLUSTER.container });
  console.log('[dev] --reset: database wiped back to a factory state — no demo data, no password, no history');
  console.log(removed
    ? `[dev] --reset: removed the dev k3s cluster (${DEV_CLUSTER.container})`
    : '[dev] --reset: no dev k3s cluster to remove');
  // Worth saying plainly: the "seed when empty" rule below is what runs next
  // time, so a plain `npm run dev` after this puts the demo data back.
  console.log('[dev] --reset: the next `npm run dev` will seed again, because the database is now empty');
} else if (reseed || store.listEndpoints().length === 0) {
  const kubeconfig = await provisionDevCluster();
  const counts = seedDemoData(MOCK_PORT, { kubeconfig });
  console.log(`[dev] seeded ${counts.endpoints} endpoints, ${counts.flatline_groups} Flatline groups, `
    + `${counts.targets} action targets, ${counts.action_groups} action groups`);
} else {
  console.log('[dev] existing dev database kept — pass --reseed to start over, or --reset to empty it');
}

if (driveOutage) watchWaits(store);

console.log(`[dev] data dir: ${process.env.FLATLINE_DATA_DIR}`);
await import('../server/index.js');

/**
 * Brings up (or picks up) the dev k3s cluster and returns its kubeconfig for
 * the seed to store on a Kubernetes target. Returns null when there is no
 * cluster to be had — no Docker, or it would not start — because the dev
 * instance is still perfectly usable without one and must not be held up by it.
 */
async function provisionDevCluster() {
  const why = await dockerUnavailable();
  if (why) {
    console.log(`[dev] no Kubernetes target seeded — ${why}. Start Docker Desktop and re-run with --reseed to get one.`);
    return null;
  }

  console.log('[dev] Docker is running — bringing up a k3s cluster for the Kubernetes target (up to a minute)…');
  const cluster = await startK3sCluster({ ...DEV_CLUSTER, reuse: true });
  if (cluster.skip) {
    console.log(`[dev] no Kubernetes target seeded — ${cluster.skip}`);
    return null;
  }

  try {
    await cluster.kubectl(['apply', '-f', '-'], { input: DEV_WORKLOAD });
  } catch (err) {
    // The cluster is up, so the target is still worth having — it just has
    // less to drain than intended.
    console.log(`[dev] k3s demo workload could not be applied (${err.message.split('\n')[0]})`);
  }

  console.log(`[dev] k3s cluster ${cluster.reused ? 'reused' : 'created'}: ${cluster.container} (${K3S_TAG}) on ${cluster.apiUrl}`);
  console.log('[dev] "k3s cluster (real, in Docker)" on the Actions page drains it for real — Restore brings it back');
  console.log('[dev] pass --reset to tear it down again');
  return cluster.kubeconfig;
}

/**
 * The least time a group can possibly take: the gap held before every stage but
 * the first, plus every wait step inside them — a stage's waits gate the steps
 * below them, so they add up. Anything the targets do is on top of this.
 */
function waitFloorMs(stages) {
  return stages.reduce((ms, st, i) => {
    const inStage = st.steps
      .filter((s) => s.target_id == null)
      .reduce((n, s) => n + s.wait_seconds, 0);
    return ms + (i > 0 ? st.wait_seconds : 0) + inStage;
  }, 0) * 1000;
}

/**
 * Reports every completed run against that floor, so a regression in the waits
 * shows up here on the outage loop and not only under `npm run tests`. Runs that
 * stopped early are skipped, they would never reach the gaps they were cut off at.
 */
function watchWaits(db) {
  const reported = new Set();
  setInterval(() => {
    for (const run of db.listActionRuns(20)) {
      if (!run.ended_at || reported.has(run.id)) continue;
      reported.add(run.id);
      if (run.status !== 'completed') continue;
      const group = db.listActionGroups().find((g) => g.id === run.action_group_id);
      if (!group) continue;

      const floor = waitFloorMs(group.stages);
      const elapsed = run.ended_at - run.started_at;
      const verdict = elapsed >= floor ? 'held' : 'NOT HELD';
      console.log(`[dev] waits ${verdict}: "${run.action_group_name}" took ${(elapsed / 1000).toFixed(1)}s`
        + ` against ${(floor / 1000).toFixed(1)}s of waits`);
    }
  }, 2000).unref();
}
