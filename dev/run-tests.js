import { spawn } from 'node:child_process';

/**
 * Test entry point (`npm run tests`).
 *
 * Exists for one flag. Everything in tests/ runs hermetically against the mocks
 * in dev/, which is what the default run does. `--k8s` additionally runs
 * tests/k8s-cluster.test.js against a real single-node cluster in Docker — the
 * only way to exercise eviction semantics, disruption budgets and DaemonSet
 * recreation as a cluster actually implements them, rather than as
 * dev/mock-k8s.js says it does.
 *
 *   npm run tests               the hermetic suite
 *   npm run tests -- --k8s      also the real-cluster suite (needs Docker running)
 *   npm run tests:k8s           the same, without the `--` dance
 *
 * The cluster costs a minute or two per run and depends on the developer's
 * machine, which is why it is opt-in and never part of the default run or CI.
 * Any other argument is passed through to `node --test`, so a single file still
 * works: `npm run tests -- tests/dom.test.js`.
 */

const args = process.argv.slice(2);
const withCluster = args.includes('--k8s');
const passThrough = args.filter((a) => a !== '--k8s');

const child = spawn(
  process.execPath,
  ['--test', ...passThrough],
  {
    stdio: 'inherit',
    env: { ...process.env, ...(withCluster ? { FLATLINE_TEST_K8S: '1' } : {}) }
  }
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
