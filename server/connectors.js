import dgram from 'node:dgram';
import https from 'node:https';
import os from 'node:os';
import { Client as SshClient } from 'ssh2';
import { parse as parseYaml } from 'yaml';
import { winrmExec } from './winrm.js';

/**
 * Executes (or connectivity-tests) action targets. Three entry points:
 *   - testTarget()  — safe: proves credentials/reachability, never runs the
 *     target's configured command/action (except HTTP, whose entire purpose
 *     IS a specific request — there's no separate no-op to send instead).
 *   - runStep()     — the real thing, used by the shutdown watcher on trigger.
 *   - restoreStep() — brings a target back after a runStep(). For ssh/winrm
 *     that is the restore sequence: wake the host, wait for it to answer, then
 *     run the final step its owner configured. For k8s/http it stays a single
 *     undo (uncordon everything, or replay a configured restore request).
 *     There's no stored snapshot of prior state anywhere — a restore is only
 *     as good as what the target owner configured.
 *
 * The 'winrm' kind runs commands on a Windows host over WinRM (NTLMv2, see
 * winrm.js): the config identifies the machine and login, and the command
 * runs via remote PowerShell.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 8_000;

/** Formats a finished remote command the same way for SSH and WinRM. */
function formatRun(code, output, noun) {
  const out = output.trim();
  return {
    ok: code === 0,
    message: code === 0
      ? (out || `${noun} completed`)
      : `${noun} exited ${code}${out ? `: ${out.slice(0, 500)}` : ''}`
  };
}

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

/**
 * Brings a target back after a runStep() — the ssh/winrm restore sequence, a
 * configured restore request (http), or the k8s drain/custom handling below.
 *
 * `relay` is only used by the ssh/winrm sequence, and only when the target is
 * set to wake through one. It is passed in already resolved and decrypted,
 * because this module talks to machines and never to the database.
 */
export async function restoreStep(kind, config, secrets, timeoutMs = DEFAULT_TIMEOUT_MS, relay = null) {
  switch (kind) {
    case 'ssh': return restoreSequence(kind, config, secrets, timeoutMs, relay);
    case 'winrm': return restoreSequence(kind, config, secrets, timeoutMs, relay);
    case 'http': return restoreHttp(config, secrets, timeoutMs);
    case 'k8s': return restoreK8s(config, secrets, timeoutMs);
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

/** Connects, runs one command, formats the outcome — shared by the trigger
 *  command and the restore sequence's final step. */
async function execSsh(config, secrets, command, timeoutMs, noun) {
  let conn;
  try {
    conn = await sshConnect(config, secrets, Math.min(timeoutMs, TEST_TIMEOUT_MS * 2));
    const { code, output } = await execOnce(conn, command, timeoutMs, secrets.sudo_password);
    return formatRun(code, output, noun);
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    conn?.end();
  }
}

async function runSsh(config, secrets, timeoutMs) {
  if (!config.command) return { ok: false, message: 'no command configured' };
  return execSsh(config, secrets, config.command, timeoutMs, 'command');
}

// ---------------- WinRM ----------------
// See winrm.js — commands run on the Windows host via remote PowerShell over
// WinRM (NTLMv2 auth, message sealing). The stored password is the only secret.

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

/** Runs one command over WinRM — shared by the trigger command and the restore
 *  sequence's final step. */
async function execWinrm(config, secrets, command, timeoutMs, noun) {
  try {
    const { code, stdout, stderr } = await winrmExec(config, secrets, command, timeoutMs);
    return formatRun(code, stdout || stderr, noun);
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function runWinrm(config, secrets, timeoutMs) {
  if (!config.command) return { ok: false, message: 'no command configured' };
  return execWinrm(config, secrets, config.command, timeoutMs, 'command');
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

// ---------------- Restore sequence (ssh / winrm) ----------------
// Three parts, each optional except the wait that joins them: wake the host
// with a magic packet, wait for it to answer again, then run one final step —
// a command on the host, or an HTTP request Flatline sends itself.
//
// The wait is what makes the final step safe to configure at all: a machine
// that has just been woken refuses connections for a while, so the step has to
// hold until the host is actually back rather than firing and failing.

const WOL_PORT = 9;
const DEFAULT_BROADCAST = '255.255.255.255';
const DEFAULT_RESTORE_WAIT_S = 300;
const REACHABILITY_POLL_MS = 10_000;

/** The magic packet itself: 6 x 0xFF, then the MAC repeated 16 times. */
function magicPacket(mac) {
  const macBytes = Buffer.from(mac.split(':').map((h) => parseInt(h, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBytes)]);
}

/** The .255 for one interface's own subnet, from its address and netmask. */
function directedBroadcast(address, netmask) {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((octet, i) => (octet & m[i]) | (~m[i] & 0xff)).join('.');
}

/**
 * Where to send when the target has no explicit broadcast address: every
 * non-internal IPv4 interface's own directed broadcast, sent from that
 * interface.
 *
 * A plain 255.255.255.255 from an unbound socket leaves by exactly one
 * interface, whichever the routing table picks — on a host with Hyper-V, WSL or
 * Docker adapters that is regularly not the LAN the target is on. Sending one
 * packet per interface removes the guess.
 */
function localBroadcastTargets() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => ({ from: a.address, to: directedBroadcast(a.address, a.netmask) }));
}

/** Sends one packet, optionally out of a specific local interface. */
function sendPacket(packet, from, to) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closing */ }
      if (err) reject(err); else resolve();
    };

    socket.once('error', done);
    socket.bind(0, from, () => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        done(err);
        return;
      }
      socket.send(packet, WOL_PORT, to, done);
    });
  });
}

/**
 * Wakes a host. With no broadcast address configured the packet goes out every
 * local network (see localBroadcastTargets); with one, it goes exactly there
 * and normal routing applies — which is how you reach a subnet this host is not
 * itself on, provided the router forwards directed broadcasts.
 *
 * Returns the destinations that accepted the packet, for the activity message:
 * a wake that went nowhere useful is otherwise indistinguishable from one that
 * worked, since nothing ever answers a magic packet.
 */
async function sendMagicPacket(mac, broadcast) {
  const packet = magicPacket(mac);
  const explicit = broadcast && broadcast !== DEFAULT_BROADCAST;
  const destinations = explicit
    ? [{ from: undefined, to: broadcast }]
    : localBroadcastTargets();

  if (destinations.length === 0) {
    throw new Error('no local network interface to broadcast on');
  }

  const sent = [];
  const failed = [];
  for (const { from, to } of destinations) {
    try {
      await sendPacket(packet, from, to);
      sent.push(to);
    } catch (err) {
      failed.push(`${to} (${err.message})`);
    }
  }

  if (sent.length === 0) throw new Error(failed.join(', '));
  return sent;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the target's own connectivity test until it answers or the budget runs
 *  out. Failures along the way are expected — a booting host refuses
 *  connections — so only the deadline is fatal. */
async function waitUntilReachable(kind, config, secrets, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const result = kind === 'ssh' ? await testSsh(config, secrets) : await testWinrm(config, secrets);
    if (result.ok) return result;
    const left = deadline - Date.now();
    if (left <= 0) return result;
    await delay(Math.min(REACHABILITY_POLL_MS, left));
  }
}

/** The restore step's HTTP request authenticates on its own — restore_* config
 *  and its own stored secrets — because the service being resumed need not be
 *  the host that was shut down. */
function restoreAuthHeaders(config, secrets) {
  return httpAuthHeaders(
    {
      auth_scheme: config.restore_auth_scheme,
      header_name: config.restore_header_name,
      username: config.restore_username
    },
    { token: secrets.restore_token, password: secrets.restore_password }
  );
}

/**
 * Wakes the target through a relay: a machine already on its network runs the
 * relay's own command with {mac} substituted, so the broadcast originates
 * somewhere it can actually reach the target.
 *
 * `relay` is resolved by the caller (connectors.js does not read the database),
 * shaped { name, kind, config, secrets, wake_command }.
 */
async function wakeViaRelay(relay, mac, timeoutMs) {
  const command = relay.wake_command.replaceAll('{mac}', mac);
  const result = relay.kind === 'ssh'
    ? await execSsh(relay.config, relay.secrets, command, timeoutMs, 'relay wake command')
    : await execWinrm(relay.config, relay.secrets, command, timeoutMs, 'relay wake command');
  return result.ok
    ? { ok: true, message: `relay "${relay.name}" sent Wake-on-LAN for ${mac}` }
    : { ok: false, message: `relay "${relay.name}" failed to wake ${mac}: ${result.message}` };
}

async function restoreSequence(kind, config, secrets, timeoutMs, relay = null) {
  const action = config.restore_action ?? 'none';
  if (!config.wol_mac && action === 'none') {
    return { ok: false, message: 'no restore configured for this target' };
  }

  const done = [];
  if (config.wol_mac) {
    if (config.wake_mode === 'relay') {
      // A relay that was deleted after the target was configured: say so rather
      // than quietly skipping the wake and waiting out the whole timeout.
      if (!relay) {
        return { ok: false, message: 'this target wakes through a relay, but that relay no longer exists' };
      }
      const woke = await wakeViaRelay(relay, config.wol_mac, timeoutMs);
      if (!woke.ok) return woke;
      done.push(woke.message);
    } else {
      try {
        const sentTo = await sendMagicPacket(config.wol_mac, config.wol_broadcast);
        done.push(`sent Wake-on-LAN for ${config.wol_mac} via ${sentTo.join(', ')}`);
      } catch (err) {
        return { ok: false, message: `Wake-on-LAN failed: ${err.message}` };
      }
    }
  }

  const proto = kind === 'ssh' ? 'SSH' : 'WinRM';
  const waitSeconds = config.restore_wait_seconds ?? DEFAULT_RESTORE_WAIT_S;
  const reachable = await waitUntilReachable(kind, config, secrets, waitSeconds);
  if (!reachable.ok) {
    done.push(`${proto} did not answer within ${waitSeconds}s (${reachable.message})`);
    return { ok: false, message: done.join('; ') };
  }
  done.push(`${proto} answered`);

  if (action === 'none') return { ok: true, message: done.join('; ') };

  const result = action === 'command'
    ? (kind === 'ssh'
        ? await execSsh(config, secrets, config.restore_command, timeoutMs, 'restore command')
        : await execWinrm(config, secrets, config.restore_command, timeoutMs, 'restore command'))
    : await sendHttp(config.restore_url, config.restore_method ?? 'POST', config.restore_body,
        restoreAuthHeaders(config, secrets), timeoutMs);

  done.push(result.message);
  return { ok: result.ok, message: done.join('; ') };
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

