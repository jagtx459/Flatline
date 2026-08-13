import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * A single-node Kubernetes cluster in Docker, used two ways:
 *
 *   - the tests (tests/k8s-cluster.test.js, `npm run tests -- --k8s`) create one
 *     per run and tear it down after;
 *   - the dev instance (`npm run dev -- --reseed`) keeps one alive so the
 *     seeded Kubernetes target has a real cluster to drain and restore.
 *
 * They get separate containers and separate ports on purpose: each start
 * removes any container of its own name, so sharing one would mean a test run
 * silently destroying the cluster a dev instance was pointed at.
 *
 * k3s is run as a plain container rather than through k3d or kind, so the only
 * thing a developer needs installed is Docker itself — Docker Desktop is enough.
 *
 * startK3sCluster() returns { kubeconfig, apiUrl, kubectl, stop } or { skip }
 * with a readable reason, so a caller can say why it did not run rather than
 * failing on a machine that was never going to have a cluster.
 */

const run = promisify(execFile);

/**
 * The Kubernetes version the throwaway clusters run. Change this one line to
 * test against a different one — any tag from
 * https://hub.docker.com/r/rancher/k3s/tags works, and nothing else here is
 * tied to a particular version.
 *
 * Worth revisiting now and then: pinning is what keeps a test run reproducible,
 * but a pin left alone quietly becomes "the drain works on a Kubernetes nobody
 * runs any more".
 */
export const K3S_TAG = 'v1.35.7-k3s1';

const IMAGE = `rancher/k3s:${K3S_TAG}`;
const READY_TIMEOUT_MS = 180_000;

// Ports well away from 6443: a developer may well have a real cluster there.
export const TEST_CLUSTER = { container: 'flatline-test-k3s', apiPort: 16443 };
export const DEV_CLUSTER = { container: 'flatline-dev-k3s', apiPort: 16444 };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function docker(args, opts = {}) {
  return run('docker', args, { maxBuffer: 16 * 1024 * 1024, ...opts });
}

/** Docker puts the useful part on stderr; the Error's own message only says
 *  which command failed. */
function firstLine(err) {
  return (err.stderr || err.message).split('\n')[0].trim();
}

/** Whether Docker itself is up. Returns null when it is, a reason when it isn't.
 *  Not installed and installed-but-stopped are different problems with
 *  different fixes, so they are not reported as the same thing. */
export async function dockerUnavailable() {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}']);
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return 'the docker command was not found on PATH';
    return `Docker is not reachable (${firstLine(err)})`;
  }
}

/** Removes a cluster container — the one left by an interrupted run, or the
 *  dev one on `--reset`. Safe to call when there is nothing there. */
export async function stopK3sCluster({ container = TEST_CLUSTER.container } = {}) {
  try {
    await docker(['rm', '-f', container]);
    return true;
  } catch {
    return false; // nothing to remove
  }
}

async function isRunning(container) {
  try {
    const { stdout } = await docker(['inspect', '-f', '{{.State.Running}}', container]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Fetches the k3s image if this machine does not have it yet.
 *
 * `docker run` would pull it implicitly, but on a fresh clone that means several
 * minutes of silence while a few hundred MB come down, with nothing on screen to
 * say why. Pulling explicitly lets the download report itself, and separates "the
 * image could not be fetched" from "the container would not start".
 */
async function ensureImage() {
  try {
    await docker(['image', 'inspect', IMAGE]);
    return null;
  } catch { /* not here yet — pull it below */ }

  console.log(`[k3s] pulling ${IMAGE} (first run only; a few hundred MB)…`);
  return new Promise((resolve) => {
    // Inherited stdio so Docker's own progress reaches the terminal: this is
    // the long wait, and it is the one worth watching.
    const child = spawn('docker', ['pull', IMAGE], { stdio: 'inherit' });
    child.on('error', (err) => resolve(`could not run docker pull: ${err.message}`));
    child.on('close', (code) => resolve(code === 0 ? null : `docker pull ${IMAGE} exited ${code}`));
  });
}

/**
 * Brings a cluster up and waits until it can actually take a pod.
 *
 * `reuse` keeps a container of the same name that is already running instead of
 * replacing it — what the dev instance wants, so restarting it costs seconds
 * rather than a minute. The tests leave it off and always start clean.
 */
export async function startK3sCluster({
  container = TEST_CLUSTER.container,
  apiPort = TEST_CLUSTER.apiPort,
  reuse = false
} = {}) {
  const unavailable = await dockerUnavailable();
  if (unavailable) return { skip: `${unavailable} — start Docker Desktop to use this` };

  const reused = reuse && await isRunning(container);
  if (!reused) {
    const pullFailed = await ensureImage();
    if (pullFailed) return { skip: pullFailed };

    await stopK3sCluster({ container });
    try {
      // --privileged is what k3s needs to run its own containerd inside Docker.
      // traefik and servicelb are disabled: they add a minute to startup and
      // nothing here looks at them.
      await docker(['run', '-d', '--privileged', '--name', container,
        '-p', `${apiPort}:6443`, IMAGE,
        'server', '--disable=traefik', '--disable=servicelb', '--disable=metrics-server',
        '--tls-san=127.0.0.1']);
    } catch (err) {
      await stopK3sCluster({ container });
      return { skip: `could not start the k3s container: ${firstLine(err)}` };
    }
  }

  const stop = async () => { await stopK3sCluster({ container }); };
  const kubectl = (args, opts) => runKubectl(container, args, opts);

  // k3s writes its kubeconfig once the API server is up; the file is absent
  // until then, so this doubles as the readiness check.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let kubeconfig = null;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await docker(['exec', container, 'cat', '/etc/rancher/k3s/k3s.yaml']);
      if (stdout.includes('client-certificate-data') || stdout.includes('token')) {
        // The file says https://127.0.0.1:6443 — the port inside the container,
        // not the one it was published on.
        kubeconfig = stdout.replace(/https:\/\/127\.0\.0\.1:6443/g, `https://127.0.0.1:${apiPort}`);
        break;
      }
    } catch { /* still starting */ }
    await delay(2000);
  }
  if (!kubeconfig) {
    await stop();
    return { skip: `the k3s container did not become ready within ${READY_TIMEOUT_MS / 1000}s` };
  }

  // /readyz is necessary but nowhere near sufficient: the API server answers it
  // while k3s is still registering the node and applying its bootstrap
  // manifests, and it reloads during that window — which kills any exec already
  // running against it (the symptom is a kubectl that dies with 137 a second
  // after it started). Waiting for the node to go Ready puts the cluster past
  // that, and it is also the first point at which a pod could be scheduled,
  // which is what the fixtures need.
  //
  // The wait is retried rather than trusted once, because it is itself an exec
  // that can be killed by the very reload it is waiting out.
  while (Date.now() < deadline) {
    try {
      await docker(['exec', container, 'kubectl', 'get', '--raw', '/readyz']);
      await docker(['exec', container, 'kubectl', 'wait', '--for=condition=Ready', 'node', '--all', '--timeout=30s']);
      // Nothing can be created in a namespace before its default
      // ServiceAccount exists; without this the first `apply` can 403.
      await docker(['exec', container, 'kubectl', 'get', 'serviceaccount', 'default']);
      return { kubeconfig, apiUrl: `https://127.0.0.1:${apiPort}`, stop, kubectl, reused, container };
    } catch { /* not settled yet */ }
    await delay(3000);
  }

  await stop();
  return { skip: 'the k3s API server never reported ready' };
}

/** Runs kubectl inside a cluster container — for arranging fixtures and for
 *  reading back what the cluster did, without adding a kubectl dependency on
 *  the developer's machine. `input` is piped to stdin, for `apply -f -`. */
function runKubectl(container, args, { input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'kubectl', ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`kubectl ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}
