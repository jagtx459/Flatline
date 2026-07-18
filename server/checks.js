import { spawn } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

export async function runCheck(endpoint) {
  if (endpoint.type === 'icmp') {
    return icmpCheck(endpoint.target, endpoint.timeout_ms);
  }
  return httpCheck(endpoint.target, endpoint.timeout_ms, endpoint.expect_status, endpoint.expect_json);
}

// Shells out to the system ping so no raw-socket privileges are needed.
// Success requires a "time=" reply line: on Windows, exit code 0 also covers
// "Destination host unreachable" replies, which must count as failures.
// The Linux branch matches busybox ping (node:24-alpine) as well as iputils.
function icmpCheck(target, timeoutMs) {
  return new Promise((resolve) => {
    const args = IS_WINDOWS
      ? ['-n', '1', '-w', String(timeoutMs), target]
      : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), target];

    const child = spawn('ping', args, { windowsHide: true });
    let out = '';
    let settled = false;

    const guard = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); resolve(fail('timeout')); }
    }, timeoutMs + 2000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(guard); resolve(fail(err.message)); }
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      const m = out.match(/time[=<]\s*([\d.]+)\s*ms/i);
      if (m) {
        resolve({ ts: Date.now(), ok: true, latencyMs: parseFloat(m[1]) });
        return;
      }
      const reason =
        /unreachable/i.test(out) ? 'destination unreachable' :
        /timed out/i.test(out) ? 'request timed out' :
        /could not find host|name or service not known|unknown host|bad address/i.test(out) ? 'unknown host' :
        'no reply';
      resolve(fail(reason));
    });
  });
}

async function httpCheck(target, timeoutMs, expectStatus, expectJson) {
  const started = Date.now();
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'flatline-monitor' }
    });
    const latencyMs = Date.now() - started;
    const body = await res.arrayBuffer().catch(() => new ArrayBuffer(0));

    let ok = expectStatus != null ? res.status === expectStatus : res.status < 400;
    let error = ok ? null : `unexpected status ${res.status}`;

    if (ok && expectJson != null) {
      const expected = JSON.parse(expectJson); // validated at save time
      let actual;
      try {
        actual = JSON.parse(Buffer.from(body).toString('utf-8'));
      } catch {
        ok = false;
        error = 'response is not valid JSON';
      }
      if (ok && !jsonMatches(expected, actual)) {
        ok = false;
        error = 'response JSON did not match expected';
      }
    }

    return { ts: Date.now(), ok, latencyMs, statusCode: res.status, error };
  } catch (err) {
    const reason = err.name === 'TimeoutError'
      ? 'timeout'
      : (err.cause?.code ?? err.cause?.message ?? err.message);
    return fail(String(reason));
  }
}

/**
 * Subset match: every key/value in `expected` must be present in `actual`
 * (recursively). Extra keys in the response are fine. Arrays must match
 * element-by-element at the same length.
 */
function jsonMatches(expected, actual) {
  if (expected !== null && typeof expected === 'object') {
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length) return false;
      return expected.every((v, i) => jsonMatches(v, actual[i]));
    }
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([k, v]) => jsonMatches(v, actual[k]));
  }
  return Object.is(expected, actual);
}

function fail(error) {
  return { ts: Date.now(), ok: false, latencyMs: null, error };
}
