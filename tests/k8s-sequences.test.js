import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runStep, restoreStep, testTarget } from '../server/connectors.js';
import { startMockK8s, node, pod, deployment } from '../dev/mock-k8s.js';

// The drain and its restore, driven against dev/mock-k8s.js — a TLS API server
// that actually applies what it is sent, so a cordon really cordons and an
// accepted eviction really removes the pod. What that cannot model is a real
// cluster's own behaviour (controllers recreating pods, kubelet timing); those
// cases live in tests/k8s-cluster.test.js, behind `npm run tests:k8s`.
//
// The connector only offers a CA for kubeconfig auth, so every target here uses
// the kubeconfig the mock hands out. Its `blocked` pods stand in for a
// disruption budget refusing an eviction.
//
// The mock needs openssl to mint its certificate; without it these skip.

let mock;
const SKIP = 'needs openssl to mint a self-signed certificate';

/** Rebuilds the cluster for one test. Each gets its own server, because the
 *  drain mutates state and a shared one would leak between cases. */
async function cluster(state) {
  mock?.close();
  mock = await startMockK8s(state);
  return mock;
}

// Uncordoning used to be inferred from a 'drain' action; it is an explicit part
// of the restore now, so the baseline turns it on the way the form does.
const target = (over = {}) => ({
  auth_method: 'kubeconfig', action: 'drain',
  restore_enabled: 1, restore_kind: 'k8s', restore_inherit: 1, restore_uncordon: 1,
  restore_wait_seconds: 1, ...over
});
const secrets = () => ({ kubeconfig: mock.kubeconfig });

before(async () => { mock = await startMockK8s(); });
after(() => mock?.close());

describe('reaching the cluster', () => {
  test('a kubeconfig with an embedded CA connects over TLS', async (t) => {
    if (!await cluster()) return t.skip(SKIP);
    const result = await testTarget('k8s', target(), secrets());
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /cluster version v1\.31\.0-mock/);
  });

  test('a kubeconfig whose token the cluster rejects fails plainly', async (t) => {
    if (!await cluster()) return t.skip(SKIP);
    const result = await testTarget('k8s', target(), { kubeconfig: mock.kubeconfig.replace(/token: .*/, 'token: wrong') });
    assert.equal(result.ok, false);
    assert.match(result.message, /401/);
  });
});

describe('the drain', () => {
  test('cordons every node, evicts the pods, and reports the cluster it found', async (t) => {
    const c = await cluster({
      nodes: [node('node-1'), node('node-2')],
      pods: [
        pod('default', 'web-1', { nodeName: 'node-1' }),
        pod('default', 'web-2', { nodeName: 'node-2' }),
        pod('kube-system', 'kube-proxy-1', { nodeName: 'node-1', owner: 'DaemonSet' })
      ],
      deployments: [deployment('default', 'web')],
      statefulsets: [{ metadata: { namespace: 'default', name: 'db' } }]
    });
    if (!c) return t.skip(SKIP);

    const result = await runStep('k8s', target(), secrets(), 10_000);

    assert.equal(result.ok, true, result.message);
    assert.equal(c.cluster.nodes.every((n) => n.spec.unschedulable), true, 'every node is cordoned');
    // The DaemonSet pod stays: its controller would put it straight back, so
    // waiting on it would mean waiting forever.
    assert.deepEqual(c.cluster.pods.map((p) => p.metadata.name), ['kube-proxy-1']);
    assert.match(result.message, /drained after \d+s/);
  });

  test('the snapshot is taken before anything is touched', async (t) => {
    const c = await cluster({
      nodes: [node('node-1')],
      pods: [pod('default', 'web-1'), pod('default', 'job-1', { owner: 'Job', phase: 'Succeeded' })],
      deployments: [deployment('default', 'web')],
      daemonsets: [{ metadata: { namespace: 'kube-system', name: 'kube-proxy' } }]
    });
    if (!c) return t.skip(SKIP);

    const result = await runStep('k8s', target(), secrets(), 10_000);

    // Once the pods are gone this line is the only record of what was running.
    assert.match(result.message, /snapshot: 2 ns, 1 deploy, 0 sts, 1 ds, 2 pods \(1 evictable\)/);
    // And it was taken before the first cordon.
    const snapshotAt = c.requests.indexOf('GET apis/apps/v1/deployments');
    const cordonAt = c.requests.findIndex((r) => r.startsWith('PATCH api/v1/nodes/'));
    assert.equal(snapshotAt < cordonAt, true, `snapshot at ${snapshotAt}, first cordon at ${cordonAt}`);
  });

  test('a count that cannot be fetched degrades to ?, and the drain still runs', async (t) => {
    // The snapshot is a record of what happened, not a gate on it happening.
    const c = await cluster({
      nodes: [node('node-1')],
      pods: [pod('default', 'web-1')],
      fail: { 'apis/apps/v1/statefulsets': 500 }
    });
    if (!c) return t.skip(SKIP);

    const result = await runStep('k8s', target(), secrets(), 10_000);
    assert.match(result.message, /\? sts/);
    assert.equal(result.ok, true, result.message);
    assert.equal(c.cluster.pods.length, 0);
  });

  test('a pod refused by a disruption budget is asked again, not given up on', async (t) => {
    // kubectl drain re-issues too: a 429 means "not yet", and asking once would
    // stall until the deadline for no reason.
    const c = await cluster({
      nodes: [node('node-1')],
      pods: [pod('default', 'web-1')],
      refuseEvictions: 1 // the first attempt comes back 429
    });
    if (!c) return t.skip(SKIP);

    const result = await runStep('k8s', target(), secrets(), 20_000);

    assert.equal(result.ok, true, result.message);
    assert.equal(c.cluster.pods.length, 0, 'it went once the budget allowed it');
    const evictions = c.requests.filter((r) => r.endsWith('/eviction')).length;
    assert.equal(evictions >= 2, true, `expected the eviction to be re-issued, saw ${evictions}`);
  });

  test('a pod that never goes fails the step at its deadline, naming what is left', async (t) => {
    const c = await cluster({
      nodes: [node('node-1')],
      pods: [pod('default', 'stuck-1', { blocked: true }), pod('default', 'web-1')]
    });
    if (!c) return t.skip(SKIP);

    const result = await runStep('k8s', target(), secrets(), 2000);

    assert.equal(result.ok, false);
    assert.match(result.message, /NOT drained after \d+s — 1 pod\(s\) still running: default\/stuck-1/);
    assert.deepEqual(c.cluster.pods.map((p) => p.metadata.name), ['stuck-1'], 'the others still went');
  });

  test('pods that can never be evicted do not hold the step open', async (t) => {
    const c = await cluster({
      nodes: [node('node-1')],
      pods: [
        pod('kube-system', 'etcd-node-1', { owner: 'Node' }),
        pod('kube-system', 'apiserver-node-1', { owner: null, mirror: true }),
        pod('kube-system', 'kube-proxy-1', { owner: 'DaemonSet' }),
        pod('default', 'job-1', { owner: 'Job', phase: 'Succeeded' })
      ]
    });
    if (!c) return t.skip(SKIP);

    const result = await runStep('k8s', target(), secrets(), 5000);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /drained after/);
    assert.equal(c.cluster.pods.length, 4, 'and none of them were evicted');
  });

  test('a cluster with no nodes is an error, not an empty success', async (t) => {
    if (!await cluster({ nodes: [] })) return t.skip(SKIP);
    const result = await runStep('k8s', target(), secrets(), 5000);
    assert.equal(result.ok, false);
    assert.match(result.message, /no nodes found/);
  });

  test('a node that will not cordon fails the step but the others still drain', async (t) => {
    const c = await cluster({ nodes: [node('node-1')], pods: [], fail: { 'api/v1/nodes/node-1': 403 } });
    if (!c) return t.skip(SKIP);

    const result = await runStep('k8s', target(), secrets(), 5000);
    assert.equal(result.ok, false);
    assert.match(result.message, /node-1: FAILED \(cordon failed: 403\)/);
  });
});

describe('the custom action', () => {
  test('sends the request the target defined, with its own method', async (t) => {
    const c = await cluster();
    if (!c) return t.skip(SKIP);

    const result = await runStep('k8s', target({
      action: 'custom',
      command_method: 'PATCH',
      command_path: 'apis/apps/v1/namespaces/default/deployments/web/scale',
      command_body: '{"spec":{"replicas":0}}'
    }), secrets(), 5000);

    assert.equal(result.ok, true, result.message);
    assert.equal(c.requests.includes('PATCH apis/apps/v1/namespaces/default/deployments/web/scale'), true);
    assert.equal(c.requests.some((r) => r.startsWith('PATCH api/v1/nodes/')), false, 'nothing was cordoned');
  });
});

describe('the restore', () => {
  beforeEach(() => { /* each test builds its own cluster */ });

  test('uncordons every node once the API server answers', async (t) => {
    const c = await cluster({ nodes: [node('node-1'), node('node-2')] });
    if (!c) return t.skip(SKIP);
    for (const n of c.cluster.nodes) n.spec.unschedulable = true;

    const result = await restoreStep('k8s', target(), secrets(), 5000);

    assert.equal(result.ok, true, result.message);
    assert.equal(c.cluster.nodes.every((n) => !n.spec.unschedulable), true);
    assert.match(result.message, /API server answered/);
  });

  test('an unusable kubeconfig fails immediately rather than after the wait', async (t) => {
    // Five minutes of polling is not going to fix a missing credential, and the
    // wait would bury the real reason behind a timeout message.
    if (!await cluster()) return t.skip(SKIP);
    const started = Date.now();
    const result = await restoreStep('k8s', target({ restore_wait_seconds: 30 }), { kubeconfig: 'not: [valid' }, 5000);

    assert.equal(result.ok, false);
    assert.equal(Date.now() - started < 2000, true, 'it did not sit through the wait');
    assert.match(result.message, /kubeconfig/);
  });

  test('an API server that never answers fails with the budget it waited', async (t) => {
    const c = await cluster();
    if (!c) return t.skip(SKIP);
    const kubeconfig = c.kubeconfig;
    await new Promise((resolve) => c.close(resolve));

    const result = await restoreStep('k8s', target({ restore_wait_seconds: 1 }), { kubeconfig }, 5000);
    assert.equal(result.ok, false);
    assert.match(result.message, /API server did not answer within 1s/);
    mock = null;
  });

  test('the steps run in the order a cluster needs them', async (t) => {
    // Uncordon, then the target's own undo, then push the workloads: scaling
    // back up achieves nothing while every node is still unschedulable.
    const c = await cluster({
      nodes: [node('node-1')],
      deployments: [deployment('default', 'web')]
    });
    if (!c) return t.skip(SKIP);
    c.cluster.nodes[0].spec.unschedulable = true;

    const result = await restoreStep('k8s', target({
      restore_path: 'apis/apps/v1/namespaces/default/deployments/web/scale',
      restore_method: 'PATCH',
      restore_body: '{"spec":{"replicas":3}}',
      restore_restart_deployments: 1
    }), secrets(), 5000);
    assert.equal(result.ok, true, result.message);

    const uncordonAt = c.requests.indexOf('PATCH api/v1/nodes/node-1');
    const undoAt = c.requests.indexOf('PATCH apis/apps/v1/namespaces/default/deployments/web/scale');
    const restartAt = c.requests.indexOf('GET apis/apps/v1/deployments');
    assert.equal(uncordonAt < undoAt && undoAt < restartAt, true,
      `uncordon ${uncordonAt}, undo ${undoAt}, restart ${restartAt}`);
  });

  test('a failing step stops the ones behind it', async (t) => {
    // There is no point restarting workloads onto nodes that would not take
    // their pods.
    const c = await cluster({
      nodes: [node('node-1')],
      deployments: [deployment('default', 'web')],
      fail: { 'api/v1/nodes/node-1': 403 }
    });
    if (!c) return t.skip(SKIP);

    const result = await restoreStep('k8s', target({ restore_restart_deployments: 1 }), secrets(), 5000);

    assert.equal(result.ok, false);
    assert.match(result.message, /node-1: FAILED/);
    assert.equal(c.requests.includes('GET apis/apps/v1/deployments'), false, 'the restart never started');
  });

  test('a drain target always uncordons; a custom one only when asked', async (t) => {
    // Uncordoning is now asked for, not inferred from the trigger action — the
    // cluster being restored need not be the one this target shut down.
    const c = await cluster({ nodes: [node('node-1')] });
    if (!c) return t.skip(SKIP);
    c.cluster.nodes[0].spec.unschedulable = true;

    await restoreStep('k8s', target({
      restore_uncordon: 0,
      restore_path: 'apis/apps/v1/namespaces/default/deployments/web/scale'
    }), secrets(), 5000);
    assert.equal(c.cluster.nodes[0].spec.unschedulable, true, 'left alone when not asked for');

    await restoreStep('k8s', target({ restore_uncordon: 1 }), secrets(), 5000);
    assert.equal(c.cluster.nodes[0].spec.unschedulable, false, 'until it was asked');
  });

  test('a restore with no steps still confirms the cluster came back', async (t) => {
    // The form refuses to save this (see target-config.test.js), so it only
    // arises from a hand-edited config — and reaching the API server is a real
    // result, the same way a wake-only restore's wait is.
    if (!await cluster()) return t.skip(SKIP);
    const result = await restoreStep('k8s', target({ restore_uncordon: 0 }), secrets(), 5000);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /API server answered/);
  });
});

describe('the rollout restart', () => {
  test('stamps restartedAt on every Deployment outside kube-system', async (t) => {
    // It is the annotation changing, not its value, that makes a Deployment
    // roll its pods — and kube-system comes back on its own, so rolling it
    // while the cluster is still settling only makes it wobble again.
    const c = await cluster({
      nodes: [node('node-1')],
      deployments: [
        deployment('default', 'web'),
        deployment('apps', 'api'),
        deployment('kube-system', 'coredns')
      ]
    });
    if (!c) return t.skip(SKIP);

    const result = await restoreStep('k8s', target({ restore_restart_deployments: 1 }), secrets(), 5000);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /restarted 2 deployment\(s\)/);

    const stamp = (ns, name) => c.cluster.deployments
      .find((d) => d.metadata.namespace === ns && d.metadata.name === name)
      .spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'];

    assert.match(stamp('default', 'web'), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(stamp('default', 'web'), stamp('apps', 'api'), 'one stamp for the whole pass');
    assert.equal(stamp('kube-system', 'coredns'), undefined, 'kube-system is left alone');
  });

  test('a cluster with no deployments outside kube-system is not a failure', async (t) => {
    const c = await cluster({ nodes: [node('node-1')], deployments: [deployment('kube-system', 'coredns')] });
    if (!c) return t.skip(SKIP);

    const result = await restoreStep('k8s', target({ restore_restart_deployments: 1 }), secrets(), 5000);
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /no deployments to restart/);
  });

  test('a Deployment that will not patch is named, and the rest still roll', async (t) => {
    const c = await cluster({
      nodes: [node('node-1')],
      deployments: [deployment('default', 'web'), deployment('default', 'api')],
      fail: { 'apis/apps/v1/namespaces/default/deployments/web': 409 }
    });
    if (!c) return t.skip(SKIP);

    const result = await restoreStep('k8s', target({ restore_restart_deployments: 1 }), secrets(), 5000);
    assert.equal(result.ok, false);
    assert.match(result.message, /restarted 1\/2 deployment\(s\), FAILED: default\/web \(409\)/);
  });
});
