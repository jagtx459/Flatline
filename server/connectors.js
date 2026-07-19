import https from 'node:https';
import { Client as SshClient } from 'ssh2';
import { parse as parseYaml } from 'yaml';
import { winrmExec } from './winrm.js';

/**
 * Executes (or connectivity-tests) action targets. Three entry points:
 *   - testTarget()  — safe: proves credentials/reachability, never runs the
 *     target's configured command/action (except HTTP, whose entire purpose
 *     IS a specific request — there's no separate no-op to send instead).
 *   - runStep()     — the real thing, used by the shutdown watcher on trigger.
 *   - restoreStep() — undoes a prior runStep(), where that's meaningful
 *     (currently k8s only: uncordon nodes, or replay a target's configured
 *     restore command). There's no stored snapshot of prior state — the
 *     'drain' undo is just "uncordon everything" and 'custom' undo is
 *     whatever restore command the target owner configured.
 *
 * The 'winrm' kind runs commands on a Windows host over WinRM (NTLMv2, see
 * winrm.js): the config identifies the machine and login, and the command
 * runs via remote PowerShell.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 8_000;

export async function testTarget(kind, config, secrets) {
  switch (kind) {
    case 'ssh': return testSsh(config, secrets);
    case 'k8s': return testK8s(config, secrets);
    case 'http': return runHttp(config, secrets, TEST_TIMEOUT_MS);
    case 'winrm': return testWinrm(config, secrets);
    default: return { ok: false, message: `unknown kind '${kind}'` };
  }
}

export async function runStep(kind, config, secrets, timeoutMs = DEFAULT_TIMEOUT_MS) {
  switch (kind) {
    case 'ssh': return runSsh(config, secrets, timeoutMs);
    case 'http': return runHttp(config, secrets, timeoutMs);
    case 'k8s': return runK8s(config, secrets, timeoutMs);
    case 'winrm': return runWinrm(config, secrets, timeoutMs);
    default: return { ok: false, message: `unknown kind '${kind}'` };
  }
}

/** Undoes a prior runStep(), where the target owner configured how — an
 *  optional restore command (ssh), restore request (http), or the k8s-
 *  specific drain/custom handling below. */
export async function restoreStep(kind, config, secrets, timeoutMs = DEFAULT_TIMEOUT_MS) {
  switch (kind) {
    case 'ssh': return restoreSsh(config, secrets, timeoutMs);
    case 'http': return restoreHttp(config, secrets, timeoutMs);
    case 'k8s': return restoreK8s(config, secrets, timeoutMs);
    case 'winrm': return restoreWinrm(config, secrets, timeoutMs);
    default: return { ok: false, message: `restore is not supported for '${kind}' targets` };
  }
}

// ---------------- SSH ----------------

function sshConnect(config, secrets, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!config.host || !config.username) { reject(new Error('host and username are required')); return; }
    const opts = { host: config.host, port: config.port ?? 22, username: config.username, readyTimeout: timeoutMs };
    if (config.auth_method === 'key') {
      if (!secrets.private_key) { reject(new Error('no private key stored for this target')); return; }
      opts.privateKey = secrets.private_key;
      if (secrets.passphrase) opts.passphrase = secrets.passphrase;
    } else {
      if (!secrets.password) { reject(new Error('no password stored for this target')); return; }
      opts.password = secrets.password;
    }

    const conn = new SshClient();
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    conn.connect(opts);
  });
}

/** Runs one command over an established connection; optionally feeds a sudo
 *  password to stdin (works with `sudo -S`, which reads it there instead of
 *  the TTY — no pty is allocated, so plain `sudo` without -S will just fail
 *  as it would over any non-interactive SSH exec). */
function execOnce(conn, command, timeoutMs, sudoPassword) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) { reject(err); return; }
      let output = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.close();
        reject(new Error('command timed out'));
      }, timeoutMs);

      stream.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? 0, output });
      });
      stream.on('data', (d) => { output += d.toString(); });
      stream.stderr.on('data', (d) => { output += d.toString(); });
      if (sudoPassword) stream.stdin.write(sudoPassword + '\n');
    });
  });
}

async function testSsh(config, secrets) {
  let conn;
  try {
    conn = await sshConnect(config, secrets, TEST_TIMEOUT_MS);
    await execOnce(conn, 'echo flatline-ok', TEST_TIMEOUT_MS);
    return { ok: true, message: `connected to ${config.username}@${config.host}:${config.port ?? 22}` };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    conn?.end();
  }
}

async function runSsh(config, secrets, timeoutMs) {
  if (!config.command) return { ok: false, message: 'no command configured' };
  let conn;
  try {
    conn = await sshConnect(config, secrets, Math.min(timeoutMs, TEST_TIMEOUT_MS * 2));
    const { code, output } = await execOnce(conn, config.command, timeoutMs, secrets.sudo_password);
    return {
      ok: code === 0,
      message: code === 0
        ? (output.trim() || 'command completed')
        : `command exited ${code}${output ? `: ${output.trim().slice(0, 500)}` : ''}`
    };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    conn?.end();
  }
}

/** Undoes a prior runSsh() by running the target's optional restore command
 *  over the same connection/credentials — there's no stored snapshot of
 *  prior state, so this is only as good as whatever the target owner wrote. */
async function restoreSsh(config, secrets, timeoutMs) {
  if (!config.restore_command) return { ok: false, message: 'no restore command configured for this target' };
  let conn;
  try {
    conn = await sshConnect(config, secrets, Math.min(timeoutMs, TEST_TIMEOUT_MS * 2));
    const { code, output } = await execOnce(conn, config.restore_command, timeoutMs, secrets.sudo_password);
    return {
      ok: code === 0,
      message: code === 0
        ? (output.trim() || 'restore command completed')
        : `restore command exited ${code}${output ? `: ${output.trim().slice(0, 500)}` : ''}`
    };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    conn?.end();
  }
}

// ---------------- WinRM ----------------
// See winrm.js — commands run on the Windows host via remote PowerShell over
// WinRM (NTLMv2 auth, message sealing). The stored password is the only secret.

function formatRun(code, output, noun) {
  const out = output.trim();
  return {
    ok: code === 0,
    message: code === 0
      ? (out || `${noun} completed`)
      : `${noun} exited ${code}${out ? `: ${out.slice(0, 500)}` : ''}`
  };
}

async function testWinrm(config, secrets) {
  try {
    const { code } = await winrmExec(config, secrets, 'Write-Output flatline-ok', TEST_TIMEOUT_MS);
    return code === 0
      ? { ok: true, message: `connected to ${config.username}@${config.host}:${config.port ?? 5985} (WinRM)` }
      : { ok: false, message: `WinRM reachable but the test command exited ${code}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function runWinrm(config, secrets, timeoutMs) {
  if (!config.command) return { ok: false, message: 'no command configured' };
  try {
    const { code, stdout, stderr } = await winrmExec(config, secrets, config.command, timeoutMs);
    return formatRun(code, stdout || stderr, 'command');
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/** Undoes a prior runWinrm() by running the target's optional restore command
 *  over WinRM with the same credentials. */
async function restoreWinrm(config, secrets, timeoutMs) {
  if (!config.restore_command) return { ok: false, message: 'no restore command configured for this target' };
  try {
    const { code, stdout, stderr } = await winrmExec(config, secrets, config.restore_command, timeoutMs);
    return formatRun(code, stdout || stderr, 'restore command');
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ---------------- HTTP ----------------

/** Auth headers are shared between the trigger request and the optional
 *  restore request — they're the same target/credentials, just a different
 *  method/url/body. */
function httpAuthHeaders(config, secrets) {
  const headers = { 'user-agent': 'flatline' };
  if (config.auth_scheme === 'bearer' && secrets.token) {
    headers.authorization = `Bearer ${secrets.token}`;
  } else if (config.auth_scheme === 'header' && secrets.token && config.header_name) {
    headers[config.header_name] = secrets.token;
  } else if (config.auth_scheme === 'basic' && config.username) {
    headers.authorization = `Basic ${Buffer.from(`${config.username}:${secrets.password ?? ''}`).toString('base64')}`;
  }
  return headers;
}

async function sendHttp(url, method, body, headers, timeoutMs) {
  headers = body ? { ...headers, 'content-type': 'application/json' } : headers;
  try {
    const res = await fetch(url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => '');
    const ok = res.status < 400;
    return { ok, message: `${method} ${url} -> ${res.status}${!ok && text ? `: ${text.slice(0, 300)}` : ''}` };
  } catch (err) {
    return { ok: false, message: describeFetchError(err) };
  }
}

async function runHttp(config, secrets, timeoutMs) {
  if (!config.url) return { ok: false, message: 'no URL configured' };
  return sendHttp(config.url, config.method ?? 'POST', config.body, httpAuthHeaders(config, secrets), timeoutMs);
}

/** Undoes a prior runHttp() via the target's optional restore request —
 *  same auth as the trigger request, different method/url/body. */
async function restoreHttp(config, secrets, timeoutMs) {
  if (!config.restore_url) return { ok: false, message: 'no restore request configured for this target' };
  return sendHttp(config.restore_url, config.restore_method ?? 'POST', config.restore_body, httpAuthHeaders(config, secrets), timeoutMs);
}

// ---------------- Kubernetes ----------------
// Auth: a plain bearer token, or a kubeconfig (parsed with the `yaml`
// package — the only viable way to read one, since it's YAML by definition).
// From the kubeconfig's current-context we support a token, a client
// certificate/key (mutual TLS), or an embedded CA cert for self-signed
// clusters; an exec-based credential plugin (aws/gke/etc.) is surfaced as a
// clear "not supported" error rather than failing silently. Requests go
// through node:https directly (not fetch) so client-cert/CA options work
// with no extra dependency.

function describeFetchError(err) {
  if (err.name === 'TimeoutError') return 'timeout';
  return err.cause?.message ?? err.message;
}

/** Resolves a target's kind/secrets into { serverUrl, token|basicAuth|cert+key, ca?, rejectUnauthorized? }. */
function resolveK8sConnection(config, secrets) {
  if (config.auth_method === 'kubeconfig') {
    if (!secrets.kubeconfig) throw new Error('no kubeconfig stored for this target');
    return connectionFromKubeconfig(secrets.kubeconfig, config.api_url);
  }
  if (!secrets.token) throw new Error('no bearer token stored for this target');
  if (!config.api_url) throw new Error('API server URL is required');
  return { serverUrl: config.api_url, token: secrets.token };
}

function connectionFromKubeconfig(text, apiUrlOverride) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new Error(`kubeconfig is not valid YAML: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object') throw new Error('kubeconfig is empty or invalid');

  const contextName = doc['current-context'];
  const context = (doc.contexts ?? []).find((c) => c.name === contextName)?.context;
  if (!context) throw new Error(`kubeconfig has no usable current-context ("${contextName ?? '(none set)'}")`);

  const cluster = (doc.clusters ?? []).find((c) => c.name === context.cluster)?.cluster;
  if (!cluster) throw new Error(`kubeconfig cluster "${context.cluster}" not found`);
  const user = (doc.users ?? []).find((u) => u.name === context.user)?.user ?? {};

  const serverUrl = apiUrlOverride || cluster.server;
  if (!serverUrl) throw new Error('kubeconfig cluster has no server URL (and no API server URL override was set)');

  const conn = { serverUrl };
  if (cluster['certificate-authority-data']) {
    conn.ca = Buffer.from(cluster['certificate-authority-data'], 'base64');
  }
  if (cluster['insecure-skip-tls-verify']) conn.rejectUnauthorized = false;

  if (user.token) {
    conn.token = user.token;
  } else if (user['client-certificate-data'] && user['client-key-data']) {
    conn.cert = Buffer.from(user['client-certificate-data'], 'base64');
    conn.key = Buffer.from(user['client-key-data'], 'base64');
  } else if (user.username && user.password) {
    conn.basicAuth = `${user.username}:${user.password}`;
  } else if (user.exec) {
    throw new Error(`kubeconfig uses an exec credential plugin ("${user.exec.command ?? 'exec'}"), which isn't supported yet — use a static token or client-certificate kubeconfig instead`);
  } else {
    throw new Error('kubeconfig user has no supported credentials (token, client certificate, or basic auth)');
  }
  return conn;
}

/** Mimics enough of the fetch Response shape (ok/status/json) for the call sites below. */
function k8sRequest(conn, path, { method = 'GET', headers = {}, body, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const base = conn.serverUrl.endsWith('/') ? conn.serverUrl : `${conn.serverUrl}/`;
    let url;
    try {
      url = new URL(path, base);
    } catch (err) {
      reject(new Error(`invalid API server URL: ${err.message}`));
      return;
    }

    const reqHeaders = { accept: 'application/json', ...headers };
    if (conn.token) reqHeaders.authorization = `Bearer ${conn.token}`;
    else if (conn.basicAuth) reqHeaders.authorization = `Basic ${Buffer.from(conn.basicAuth).toString('base64')}`;
    if (body) reqHeaders['content-type'] ??= 'application/json';

    const req = https.request(url, {
      method,
      headers: reqHeaders,
      ca: conn.ca,
      cert: conn.cert,
      key: conn.key,
      rejectUnauthorized: conn.rejectUnauthorized !== false,
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        resolve({
          ok: status < 400,
          status,
          json: async () => { try { return JSON.parse(data); } catch { return {}; } },
          text: async () => data
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function testK8s(config, secrets) {
  try {
    const conn = resolveK8sConnection(config, secrets);
    const res = await k8sRequest(conn, 'version', { timeoutMs: TEST_TIMEOUT_MS });
    if (!res.ok) return { ok: false, message: `API server responded ${res.status}` };
    const info = await res.json();
    return { ok: true, message: `connected — cluster version ${info.gitVersion ?? 'unknown'}` };
  } catch (err) {
    return { ok: false, message: describeFetchError(err) };
  }
}

async function runK8s(config, secrets, timeoutMs) {
  try {
    const conn = resolveK8sConnection(config, secrets);
    return config.action === 'custom'
      ? await runCustomK8sCommand(conn, config, timeoutMs)
      : await cordonAndDrainAllNodes(conn, timeoutMs);
  } catch (err) {
    return { ok: false, message: describeFetchError(err) };
  }
}

async function restoreK8s(config, secrets, timeoutMs) {
  try {
    const conn = resolveK8sConnection(config, secrets);
    return config.action === 'custom'
      ? await runCustomK8sRestore(conn, config, timeoutMs)
      : await uncordonAllNodes(conn, timeoutMs);
  } catch (err) {
    return { ok: false, message: describeFetchError(err) };
  }
}

async function cordonAndDrainAllNodes(conn, timeoutMs) {
  const nodesRes = await k8sRequest(conn, 'api/v1/nodes', { timeoutMs });
  if (!nodesRes.ok) return { ok: false, message: `listing nodes failed: ${nodesRes.status}` };
  const nodes = (await nodesRes.json()).items ?? [];
  if (nodes.length === 0) return { ok: false, message: 'no nodes found' };

  const results = [];
  for (const node of nodes) {
    const name = node.metadata.name;
    try {
      await patchNodeSchedulable(conn, name, true, timeoutMs);
      const evicted = await evictNodePods(conn, name, timeoutMs);
      results.push(`${name}: cordoned, ${evicted} pod(s) evicted`);
    } catch (err) {
      results.push(`${name}: FAILED (${describeFetchError(err)})`);
    }
  }
  return { ok: !results.some((r) => r.includes('FAILED')), message: results.join('; ') };
}

/** Undo for the 'drain' action — there's no snapshot of which nodes were
 *  cordoned, so this just uncordons every node in the cluster. Evicted pods
 *  come back on their own once their controllers can reschedule them. */
async function uncordonAllNodes(conn, timeoutMs) {
  const nodesRes = await k8sRequest(conn, 'api/v1/nodes', { timeoutMs });
  if (!nodesRes.ok) return { ok: false, message: `listing nodes failed: ${nodesRes.status}` };
  const nodes = (await nodesRes.json()).items ?? [];
  if (nodes.length === 0) return { ok: false, message: 'no nodes found' };

  const results = [];
  for (const node of nodes) {
    const name = node.metadata.name;
    try {
      await patchNodeSchedulable(conn, name, false, timeoutMs);
      results.push(`${name}: uncordoned`);
    } catch (err) {
      results.push(`${name}: FAILED (${describeFetchError(err)})`);
    }
  }
  return { ok: !results.some((r) => r.includes('FAILED')), message: results.join('; ') };
}

async function patchNodeSchedulable(conn, name, unschedulable, timeoutMs) {
  const res = await k8sRequest(conn, `api/v1/nodes/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({ spec: { unschedulable } }),
    timeoutMs
  });
  if (!res.ok) throw new Error(`${unschedulable ? 'cordon' : 'uncordon'} failed: ${res.status}`);
}

/** 'custom' action — an arbitrary raw Kubernetes API request the target
 *  owner defines directly (method + path + optional JSON body), with an
 *  optional mirrored restore request to undo it. This is the escape hatch
 *  for anything beyond the built-in 'drain' action (e.g. scaling a specific
 *  Deployment to 0, and back). */
async function runCustomK8sCommand(conn, config, timeoutMs) {
  return execK8sCommand(conn, config.command_method, config.command_path, config.command_body, timeoutMs, 'command');
}

async function runCustomK8sRestore(conn, config, timeoutMs) {
  if (!config.restore_path) return { ok: false, message: 'no restore command configured for this target' };
  return execK8sCommand(conn, config.restore_method, config.restore_path, config.restore_body, timeoutMs, 'restore command');
}

async function execK8sCommand(conn, method, path, body, timeoutMs, label) {
  if (!path) return { ok: false, message: `no ${label} configured` };
  const m = (method || 'PATCH').toUpperCase();
  const headers = {};
  if (body) headers['content-type'] = m === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
  const res = await k8sRequest(conn, path, { method: m, headers, body: body || undefined, timeoutMs });
  const text = await res.text();
  const suffix = text ? `: ${text.slice(0, 300)}` : '';
  return { ok: res.ok, message: `${m} ${path} -> ${res.status}${!res.ok ? suffix : ''}` };
}

/** Evicts non-DaemonSet pods scheduled on the node; a 404 (already gone) counts as success. */
async function evictNodePods(conn, nodeName, timeoutMs) {
  const podsRes = await k8sRequest(conn,
    `api/v1/pods?fieldSelector=${encodeURIComponent(`spec.nodeName=${nodeName}`)}`,
    { timeoutMs });
  if (!podsRes.ok) throw new Error(`listing pods failed: ${podsRes.status}`);
  const pods = (await podsRes.json()).items ?? [];

  let evicted = 0;
  for (const pod of pods) {
    const isDaemonSet = (pod.metadata.ownerReferences ?? []).some((o) => o.kind === 'DaemonSet');
    if (isDaemonSet) continue;
    const ns = pod.metadata.namespace;
    const podName = pod.metadata.name;
    const res = await k8sRequest(conn, `api/v1/namespaces/${ns}/pods/${podName}/eviction`, {
      method: 'POST',
      body: JSON.stringify({ apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: podName, namespace: ns } }),
      timeoutMs
    });
    if (res.ok || res.status === 404) evicted += 1;
  }
  return evicted;
}

