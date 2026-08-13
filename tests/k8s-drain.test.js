import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEvictable } from '../server/connectors.js';

// The predicate the 'drain' action holds the step open against: while any pod
// on a node is evictable, the cluster is not yet drained. Everything else about
// the drain talks to a cluster over TLS and has no test double yet (see
// BACKLOG.md) — this part is pure, and it is the part that decides whether the
// step ever finishes.

function pod(over = {}) {
  const { owners, annotations, phase = 'Running' } = over;
  return {
    metadata: {
      name: 'p', namespace: 'default',
      ...(owners ? { ownerReferences: owners } : {}),
      ...(annotations ? { annotations } : {})
    },
    spec: { nodeName: 'node-1' },
    status: { phase }
  };
}

test('a workload pod holds the drain open', () => {
  assert.equal(isEvictable(pod()), true, 'an unowned running pod');
  assert.equal(isEvictable(pod({ owners: [{ kind: 'ReplicaSet' }] })), true, 'a Deployment pod');
  assert.equal(isEvictable(pod({ owners: [{ kind: 'StatefulSet' }] })), true, 'a StatefulSet pod');
  // Scheduled but not started yet — it is on the node and about to run, so the
  // drain is not finished.
  assert.equal(isEvictable(pod({ phase: 'Pending' })), true, 'a pod still starting');
});

test('pods that can never be evicted do not hold the drain open', () => {
  // Each of these would otherwise stall the step until its deadline, since
  // nothing Flatline can send will make them go.
  assert.equal(isEvictable(pod({ owners: [{ kind: 'DaemonSet' }] })), false,
    'the DaemonSet controller puts these straight back');
  assert.equal(isEvictable(pod({ owners: [{ kind: 'Node' }] })), false,
    'a static/mirror pod on a modern cluster');
  assert.equal(isEvictable(pod({ annotations: { 'kubernetes.io/config.mirror': 'abc123' } })), false,
    'a static/mirror pod on an older cluster, marked only by annotation');
});

test('a finished pod does not hold the drain open', () => {
  assert.equal(isEvictable(pod({ owners: [{ kind: 'Job' }], phase: 'Succeeded' })), false, 'a completed Job');
  assert.equal(isEvictable(pod({ phase: 'Failed' })), false, 'a failed pod');
});

test('a pod with several owners is judged by any one of them', () => {
  // Order must not matter: an ownerReferences list is not sorted.
  assert.equal(isEvictable(pod({ owners: [{ kind: 'ReplicaSet' }, { kind: 'DaemonSet' }] })), false);
  assert.equal(isEvictable(pod({ owners: [{ kind: 'DaemonSet' }, { kind: 'ReplicaSet' }] })), false);
});
