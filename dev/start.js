import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockTargets, SCENARIO } from './mock-targets.js';

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
 *
 * --tests and --reseed combine freely. Call this file directly to pass them;
 * through npm they need the `--` separator (`npm run dev -- --reseed`), since
 * npm rejects any flag it doesn't recognise as one of its own.
 *
 * For pass/fail assertions use `npm run tests` instead — this script is the live
 * instance, not the checker.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = Number(process.env.FLATLINE_MOCK_PORT ?? 3198);

const args = process.argv.slice(2);
const reseed = args.includes('--reseed');
const driveOutage = args.includes('--tests');

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

if (reseed || store.listEndpoints().length === 0) {
  const counts = seedDemoData(MOCK_PORT);
  console.log(`[dev] seeded ${counts.endpoints} endpoints, ${counts.flatline_groups} Flatline groups, `
    + `${counts.targets} action targets, ${counts.action_groups} action groups`);
} else {
  console.log('[dev] existing dev database kept — pass --reseed to start over');
}

if (driveOutage) watchWaits(store);

console.log(`[dev] data dir: ${process.env.FLATLINE_DATA_DIR}`);
await import('../server/index.js');

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
