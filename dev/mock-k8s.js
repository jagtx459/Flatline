import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A stand-in Kubernetes API server, over real TLS, with real state.
 *
 * The connector speaks node:https and authenticates with a bearer token or a
 * kubeconfig, so a plain HTTP mock cannot exercise it at all. This serves the
 * handful of endpoints the drain and its restore use, and — the part that makes
 * it worth having — actually applies what it is sent: a cordon sets
 * spec.unschedulable, an accepted eviction removes the pod from the list, and a
 * rollout restart records the annotation it was patched with. A drain therefore
 * finishes here for the same reason it would on a cluster, rather than because
 * a fixture said so.
 *
 * What it deliberately does not model is anything the connector does not look
 * at: pod lifecycle, controllers recreating what was evicted, scheduling. Where
 * those matter, tests/k8s-cluster.test.js runs against a real throwaway cluster
 * (`npm run tests:k8s`).
 *
 * Needs openssl on PATH to mint its certificate. start() returns null when it
 * is unavailable, and the tests skip.
 */

export const MOCK_K8S_TOKEN = 'mock-cluster-token';

/** A self-signed cert for 127.0.0.1, or null when openssl cannot be used. */
function selfSignedCert() {
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'flatline-k8s-tls-'));
    const keyFile = path.join(dir, 'k.pem');
    const crtFile = path.join(dir, 'c.pem');
    // A minimal config: some system openssl.cnf files carry a v3_ca section
    // that -addext then rejects.
    const cnf = path.join(dir, 'openssl.cnf');
    writeFileSync(cnf, '[req]\ndistinguished_name=dn\n[dn]\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyFile, '-out', crtFile, '-days', '2', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-config', cnf], { stdio: 'ignore' });
    return { key: readFileSync(keyFile), cert: readFileSync(crtFile) };
  } catch {
    return null;
  }
}

/** A node, as much of one as the connector reads. */
export function node(name, over = {}) {
  return { metadata: { name }, spec: { unschedulable: false }, ...over };
}

/**
 * A pod. `owner` is an ownerReferences kind ('ReplicaSet', 'DaemonSet', ...),
 * `blocked` makes every eviction of it come back 429, the way a pod held by a
 * disruption budget does.
 */
export function pod(namespace, name, { nodeName = 'node-1', owner = 'ReplicaSet', phase = 'Running', mirror = false, blocked = false } = {}) {
  return {
    metadata: {
      name, namespace,
      ...(owner ? { ownerReferences: [{ kind: owner }] } : {}),
      ...(mirror ? { annotations: { 'kubernetes.io/config.mirror': 'abc123' } } : {})
    },
    spec: { nodeName },
    status: { phase },
    blocked
  };
}

export function deployment(namespace, name) {
  return { metadata: { namespace, name, annotations: {} }, spec: { template: { metadata: { annotations: {} } } } };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (d) => { data += d; });
    req.on('end', () => resolve(data));
  });
}

/**
 * Starts the mock. `cluster` is the initial state; the returned server exposes
 * it live as `.cluster`, plus `.requests` (every method+path seen, in order) so
 * a test can assert on ordering.
 *
 * Returns null when no certificate could be minted.
 */
export async function startMockK8s({
  nodes = [node('node-1')],
  pods = [],
  deployments = [],
  namespaces = ['default', 'kube-system'],
  statefulsets = [],
  daemonsets = [],
  // Paths that should fail, as { 'api/v1/nodes': 500 } — for the cases about a
  // step stopping the ones behind it.
  fail = {},
  // Evictions refused until this many have been attempted per pod, so a test
  // can prove the drain re-issues rather than asking once.
  refuseEvictions = 0
} = {}) {
  const tls = selfSignedCert();
  if (!tls) return null;

  const cluster = { nodes, pods, deployments, namespaces, statefulsets, daemonsets };
  const requests = [];
  const evictionAttempts = new Map();

  const server = https.createServer(tls, (req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"message":"mock failure"}');
    });
  });

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'https://127.0.0.1');
    const p = url.pathname.replace(/^\/+/, '');
    requests.push(`${req.method} ${p}`);

    if (req.headers.authorization !== `Bearer ${MOCK_K8S_TOKEN}`) {
      send(res, 401, { message: 'Unauthorized' });
      return;
    }
    if (fail[p]) {
      send(res, fail[p], { message: `mock: ${p} is set to fail` });
      return;
    }

    if (p === 'version') { send(res, 200, { gitVersion: 'v1.31.0-mock' }); return; }

    if (p === 'api/v1/nodes' && req.method === 'GET') {
      send(res, 200, { items: cluster.nodes });
      return;
    }
    const nodePatch = /^api\/v1\/nodes\/([^/]+)$/.exec(p);
    if (nodePatch && req.method === 'PATCH') {
      const name = decodeURIComponent(nodePatch[1]);
      const target = cluster.nodes.find((n) => n.metadata.name === name);
      if (!target) { send(res, 404, { message: 'node not found' }); return; }
      const patch = JSON.parse(await readBody(req));
      target.spec.unschedulable = !!patch.spec?.unschedulable;
      send(res, 200, target);
      return;
    }

    if (p === 'api/v1/pods' && req.method === 'GET') {
      const selector = url.searchParams.get('fieldSelector');
      const wanted = selector?.startsWith('spec.nodeName=') ? selector.slice('spec.nodeName='.length) : null;
      const items = cluster.pods
        .filter((pd) => !wanted || pd.spec.nodeName === wanted)
        .map(({ blocked, ...onTheWire }) => onTheWire); // `blocked` is the mock's own bookkeeping
      send(res, 200, { items });
      return;
    }

    const eviction = /^api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/eviction$/.exec(p);
    if (eviction && req.method === 'POST') {
      const [ns, name] = [decodeURIComponent(eviction[1]), decodeURIComponent(eviction[2])];
      const key = `${ns}/${name}`;
      const index = cluster.pods.findIndex((pd) => pd.metadata.namespace === ns && pd.metadata.name === name);
      if (index === -1) { send(res, 404, { message: 'pod not found' }); return; }

      const attempts = (evictionAttempts.get(key) ?? 0) + 1;
      evictionAttempts.set(key, attempts);
      // A disruption budget refuses with a 429 until it is satisfied; kubectl
      // (and Flatline) simply ask again on the next pass.
      if (cluster.pods[index].blocked || attempts <= refuseEvictions) {
        send(res, 429, { message: 'Cannot evict pod as it would violate the pod\'s disruption budget.' });
        return;
      }
      cluster.pods.splice(index, 1);
      send(res, 201, { status: 'Success' });
      return;
    }

    if (p === 'apis/apps/v1/deployments' && req.method === 'GET') {
      send(res, 200, { items: cluster.deployments });
      return;
    }
    const deployPatch = /^apis\/apps\/v1\/namespaces\/([^/]+)\/deployments\/([^/]+)$/.exec(p);
    if (deployPatch && req.method === 'PATCH') {
      const [ns, name] = [decodeURIComponent(deployPatch[1]), decodeURIComponent(deployPatch[2])];
      const target = cluster.deployments.find((d) => d.metadata.namespace === ns && d.metadata.name === name);
      if (!target) { send(res, 404, { message: 'deployment not found' }); return; }
      const patch = JSON.parse(await readBody(req));
      Object.assign(target.spec.template.metadata.annotations, patch.spec?.template?.metadata?.annotations ?? {});
      send(res, 200, target);
      return;
    }

    if (p === 'api/v1/namespaces') { send(res, 200, { items: cluster.namespaces.map((n) => ({ metadata: { name: n } })) }); return; }
    if (p === 'apis/apps/v1/statefulsets') { send(res, 200, { items: cluster.statefulsets }); return; }
    if (p === 'apis/apps/v1/daemonsets') { send(res, 200, { items: cluster.daemonsets }); return; }

    // Anything else is the 'custom' action's escape hatch: accept it and record
    // it, so a test can prove the request was sent with the method it chose.
    send(res, 200, { status: 'ok', path: p, method: req.method });
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  server.cluster = cluster;
  server.requests = requests;
  server.caCert = tls.cert.toString();
  server.apiUrl = `https://127.0.0.1:${server.address().port}`;
  /** A kubeconfig pointing at this server, for the auth_method: 'kubeconfig' path. */
  server.kubeconfig = [
    'apiVersion: v1',
    'kind: Config',
    'current-context: mock',
    'clusters:',
    '  - name: mock-cluster',
    '    cluster:',
    `      server: ${server.apiUrl}`,
    `      certificate-authority-data: ${tls.cert.toString('base64')}`,
    'contexts:',
    '  - name: mock',
    '    context:',
    '      cluster: mock-cluster',
    '      user: mock-user',
    'users:',
    '  - name: mock-user',
    '    user:',
    `      token: ${MOCK_K8S_TOKEN}`,
    ''
  ].join('\n');

  return server;
}
