import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runStep, restoreStep, testTarget } from '../server/connectors.js';
import { startK3sCluster } from '../dev/k3s-cluster.js';

// The drain against a cluster that actually implements Kubernetes, rather than
// against dev/mock-k8s.js's account of it. Only these cases can catch a wrong
// assumption about how a cluster behaves:
//
//   - an eviction is a request, and the pod goes when its container has
//     finished shutting down — not when the API returns;
//   - a PodDisruptionBudget refuses one with a 429, and on a single node can go
//     on refusing forever, which the drain has to survive by its own deadline;
//   - DaemonSet pods are recreated the moment they are evicted, so a drain that
//     waited for them would wait forever;
//   - replacement pods pile up unscheduled behind a cordon and are no part of
//     the drain;
//   - a restartedAt stamp genuinely rolls a Deployment.
//
// Opt-in: `npm run tests -- --k8s` (or `npm run tests:k8s`). It costs a minute
// or two and needs Docker running, so it is never part of the default run or of
// CI. Without the flag this file reports one skipped test and does nothing.

const ENABLED = process.env.FLATLINE_TEST_K8S === '1';

let cluster = null;
let skipReason = 'run with `npm run tests -- --k8s` to exercise a real cluster';

/** kubectl inside this run's own cluster container — bound by startK3sCluster,
 *  so these can never reach the one `npm run dev` keeps alive. */
const kubectl = (args, opts) => cluster.kubectl(args, opts);

before(async () => {
  if (!ENABLED) return;
  console.log('[k8s] starting a throwaway k3s cluster in Docker — a minute or two, longer the first time (the image has to come down)…');
  const started = await startK3sCluster();
  if (started.skip) {
    skipReason = started.skip;
    return;
  }
  cluster = started;

  // A Deployment with two replicas and a budget that will not let both go at
  // once, plus a DaemonSet — the three behaviours worth a real cluster.
  await kubectl(['apply', '-f', '-'], { input: FIXTURES });
  await kubectl(['wait', '--for=condition=available', '--timeout=120s', 'deployment/web']);
  await kubectl(['rollout', 'status', '--timeout=120s', 'daemonset/agent']);
}, { timeout: 300_000 });

after(async () => { await cluster?.stop(); }, { timeout: 120_000 });

// A workload to drain, and a DaemonSet to prove the drain does not wait on one.
//
// Deliberately no PodDisruptionBudget here: on a single-node cluster a budget
// that demands an available pod can never be satisfied once the node is
// cordoned, because the replacement can never be scheduled. That deadlock is
// real Kubernetes behaviour — `kubectl drain` hangs on it too — so it gets its
// own test below rather than being wired into the one about draining.
const FIXTURES = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      terminationGracePeriodSeconds: 5
      containers:
        - name: pause
          image: rancher/mirrored-pause:3.6
---
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: agent }
spec:
  selector: { matchLabels: { app: agent } }
  template:
    metadata: { labels: { app: agent } }
    spec:
      containers:
        - name: pause
          image: rancher/mirrored-pause:3.6
`;

/** A single-replica Deployment that a disruption budget refuses to let go of. */
const GUARDED = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: guarded }
spec:
  replicas: 1
  selector: { matchLabels: { app: guarded } }
  template:
    metadata: { labels: { app: guarded } }
    spec:
      containers:
        - name: pause
          image: rancher/mirrored-pause:3.6
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: guarded }
spec:
  minAvailable: 1
  selector: { matchLabels: { app: guarded } }
`;

const target = (over = {}) => ({ auth_method: 'kubeconfig', action: 'drain', restore_wait_seconds: 10, ...over });
const secrets = () => ({ kubeconfig: cluster.kubeconfig });

/**
 * Pods actually placed on a node, as namespace/name — which is what a drain is
 * responsible for. Once the node is cordoned the controllers keep making
 * replacements that can never be scheduled; those have no `spec.nodeName` and
 * are no part of the drain, so they are filtered out here exactly as
 * connectors.js filters them.
 */
async function scheduledPodNames(selector = null) {
  const out = await kubectl([
    'get', 'pods', '--all-namespaces',
    ...(selector ? ['-l', selector] : []),
    '-o', 'jsonpath={range .items[?(@.spec.nodeName)]}{.metadata.namespace}/{.metadata.name}{"\\n"}{end}'
  ]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** How many replicas a Deployment reports ready — exact, unlike counting pods,
 *  which during a rollout also sees the old ones still terminating. */
async function readyReplicas(name) {
  const out = await kubectl(['get', 'deployment', name, '-o', 'jsonpath={.status.readyReplicas}']);
  return Number(out.trim() || 0);
}

describe('against a real cluster', () => {
  test('connects and reports the cluster version', async (t) => {
    if (!cluster) return t.skip(skipReason);
    const result = await testTarget('k8s', target(), secrets());
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /cluster version v1\./);
  });

  test('the drain empties the node of workload pods and holds until they are gone',
    { timeout: 300_000 }, async (t) => {
      if (!cluster) return t.skip(skipReason);

      const before = await scheduledPodNames('app=web');
      assert.equal(before.length, 2, 'the fixture is up');

      const result = await runStep('k8s', target(), secrets(), 240_000);
      assert.equal(result.ok, true, result.message);

      // The step returning means the pods were actually gone, not merely asked
      // to go — this is the assertion the whole hold exists for. A real
      // eviction completes only once the container has finished shutting down.
      assert.deepEqual(await scheduledPodNames('app=web'), [], 'no web pods are still on the node');
      assert.match(result.message, /drained after \d+s/);
      assert.match(result.message, /cordoned, \d+ pod\(s\) evicted/);
    });

  test('the node really is cordoned', async (t) => {
    if (!cluster) return t.skip(skipReason);
    const out = await kubectl(['get', 'nodes', '-o', 'jsonpath={.items[*].spec.unschedulable}']);
    assert.match(out, /true/);
  });

  test('the DaemonSet pod is back on the node the drain just emptied', async (t) => {
    if (!cluster) return t.skip(skipReason);
    // Its controller puts it straight back the moment it is evicted, cordon or
    // no cordon — a drain that waited for it would never finish. (k3s runs its
    // control plane in-process rather than as static pods, so the mirror-pod
    // half of isEvictable is covered by tests/k8s-drain.test.js, not here.)
    assert.equal((await scheduledPodNames('app=agent')).length, 1);
  });

  test('the restore uncordons and rolls the workloads back out',
    { timeout: 300_000 }, async (t) => {
      if (!cluster) return t.skip(skipReason);

      const result = await restoreStep('k8s', target({ restore_restart_deployments: 1 }), secrets(), 120_000);
      assert.equal(result.ok, true, result.message);

      const unschedulable = await kubectl(['get', 'nodes', '-o', 'jsonpath={.items[*].spec.unschedulable}']);
      assert.equal(unschedulable.includes('true'), false, 'the node takes pods again');

      // The stamp is what makes the Deployment roll; the cluster acting on it
      // is the part a fixture cannot prove.
      const stamp = await kubectl(['get', 'deployment', 'web', '-o',
        'jsonpath={.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}']);
      assert.match(stamp.trim(), /^\d{4}-\d{2}-\d{2}T/);

      // rollout status, not `wait --for=available`: the latter returns at
      // minimum availability, while a rollout legitimately runs more pods than
      // the replica count until the old ones finish terminating.
      await kubectl(['rollout', 'status', '--timeout=180s', 'deployment/web']);
      assert.equal(await readyReplicas('web'), 2, 'the workload came back');
    });

  test('a pod its disruption budget will not release holds the drain to the deadline',
    { timeout: 300_000 }, async (t) => {
      if (!cluster) return t.skip(skipReason);

      // On one node this can never be satisfied: evicting the only replica
      // would take availability to zero, and its replacement cannot be
      // scheduled while the node is cordoned. Kubernetes refuses every
      // eviction with a 429, and `kubectl drain` hangs on it the same way.
      // What is being checked is that Flatline gives up at its own deadline and
      // says which pod it was still waiting on.
      await kubectl(['apply', '-f', '-'], { input: GUARDED });
      await kubectl(['rollout', 'status', '--timeout=120s', 'deployment/guarded']);

      const started = Date.now();
      const result = await runStep('k8s', target(), secrets(), 25_000);
      const elapsed = Date.now() - started;

      assert.equal(result.ok, false);
      assert.match(result.message, /NOT drained after \d+s/);
      assert.match(result.message, /default\/guarded-/, 'the pod still running is named');
      assert.equal(elapsed >= 25_000, true, `it held for its whole budget (${elapsed}ms)`);

      // The unguarded workload went, so the refusal was specific to the budget
      // rather than the drain failing wholesale.
      assert.deepEqual(await scheduledPodNames('app=web'), []);
    });
});
