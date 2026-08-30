import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The HTTP layer: how a request finds its handler.
 *
 * Everything else under tests/ drives the modules directly, so nothing covered
 * handleApi itself — the method/path dispatch, the shared CRUD resource table,
 * and the precedence that keeps sub-routes like /test and /:id/run from being
 * read as an :id. All six resources now route through one generic handler, so a
 * mistake there breaks every page at once.
 *
 * The server is spawned rather than imported: server/index.js binds a port and
 * starts the pollers at import time, and their intervals are not unref'd, so an
 * in-process import would keep the test runner alive after the assertions end.
 * A child also exercises the app exactly as it really runs.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** An ephemeral port the OS says is free right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let child;
let base;

/**
 * Same-origin proof and a JSON content-type: the API rejects mutating requests
 * without both (see security.js crossOriginBlocked), so every helper sends them.
 */
async function api(method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', origin: base },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* some routes answer with no body */ }
  return { status: res.status, body: json };
}

const GET = (p) => api('GET', p);
const POST = (p, b) => api('POST', p, b);
const PUT = (p, b) => api('PUT', p, b);
const DELETE = (p) => api('DELETE', p);

/**
 * A marker no legitimate field value or field name contains, so a leak test can
 * tell an actual credential apart from a word that merely looks like one — the
 * kind 'webhook' would otherwise match a naive search for the secret 'hook'.
 */
const SENTINEL = 'zzsecretsentinelzz';

/** Payload builders — the minimum each resource's validator accepts. */
const NEW = {
  endpoints: (over) => ({ name: 'ep', type: 'icmp', target: '127.0.0.1', ...over }),
  groups: (over) => ({ name: 'grp', mode: 'all', ...over }),
  'actions/groups': (over) => ({ name: 'ag', ...over }),
  // 127.0.0.1 on a closed port, so the background health check fails fast
  // (ECONNREFUSED) instead of hanging on an unroutable address.
  'actions/targets': (over) => ({
    name: 'tgt', kind: 'ssh',
    config: { host: '127.0.0.1', port: 1, username: 'u', auth_method: 'password', command: 'true' },
    secrets: { password: SENTINEL }, ...over
  }),
  relays: (over) => ({
    name: 'relay', kind: 'ssh',
    config: { host: '127.0.0.1', port: 1, username: 'u', auth_method: 'password' },
    wake_command: 'wakeonlan {mac}', network: '10.0.0.0/24',
    secrets: { password: SENTINEL }, ...over
  }),
  notifications: (over) => ({
    name: 'chan', kind: 'webhook',
    config: { events: ['endpoint_down'] },
    secrets: { url: `http://127.0.0.1:1/${SENTINEL}` }, ...over
  })
};

const RESOURCES = Object.keys(NEW);

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      FLATLINE_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'flatline-routes-')),
      // Keep the run hermetic: no password, no host allowlist to satisfy.
      FLATLINE_PASSWORD: '',
      FLATLINE_ALLOWED_HOSTS: ''
    }
  });

  // Wait for it to answer rather than sleeping a fixed amount.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start within 15s');
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => child?.kill());

// ---- the generic CRUD handler, across every resource it serves ----

describe('every resource lists, creates, updates and deletes', () => {
  for (const name of RESOURCES) {
    test(name, async () => {
      const empty = await GET(`/api/${name}`);
      assert.equal(empty.status, 200);
      assert.ok(Array.isArray(empty.body), 'list returns an array');

      const created = await POST(`/api/${name}`, NEW[name]());
      assert.equal(created.status, 201, `create: ${JSON.stringify(created.body)}`);
      assert.ok(Number.isInteger(created.body.id), 'create returns the new row');

      const listed = await GET(`/api/${name}`);
      assert.equal(listed.body.length, 1);

      const renamed = await PUT(`/api/${name}/${created.body.id}`, NEW[name]({ name: 'renamed' }));
      assert.equal(renamed.status, 200, `update: ${JSON.stringify(renamed.body)}`);
      assert.equal(renamed.body.name, 'renamed');

      const removed = await DELETE(`/api/${name}/${created.body.id}`);
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.body, { deleted: created.body.id });

      assert.equal((await GET(`/api/${name}`)).body.length, 0, 'gone after delete');
    });
  }
});

describe('unknown ids 404 at both path depths', () => {
  // /api/endpoints/:id is three segments, /api/actions/targets/:id is four —
  // the handler keys on the path prefix rather than a segment index because of it.
  for (const name of RESOURCES) {
    test(name, async () => {
      assert.equal((await DELETE(`/api/${name}/9999`)).status, 404);
      assert.equal((await PUT(`/api/${name}/9999`, NEW[name]())).status, 404);
      // A non-numeric id is not found either, rather than crashing.
      assert.equal((await DELETE(`/api/${name}/abc`)).status, 404);
    });
  }
});

// ---- precedence: sub-routes are matched before the generic :id handler ----

describe('sub-routes are not swallowed by the generic :id handler', () => {
  test('POST /:resource/test reaches the test route, not "id = test"', async () => {
    // Each answers 200 with its own ok/message; the failure mode being guarded
    // against is a 404 from `Number('test')` being read as an id.
    for (const [urlPath, payload] of [
      ['/api/endpoints/test', { type: 'icmp', target: '127.0.0.1' }],
      ['/api/actions/targets/test', NEW['actions/targets']()],
      ['/api/relays/test', NEW.relays()],
      ['/api/notifications/test', NEW.notifications()]
    ]) {
      const res = await POST(urlPath, payload);
      assert.equal(res.status, 200, `${urlPath} -> ${JSON.stringify(res.body)}`);
      assert.ok(res.body && typeof res.body === 'object', `${urlPath} returns a result object`);
    }
  });

  test('GET /groups/states answers the banners, not "id = states"', async () => {
    // Its own name: flatline_groups declares one unique, and the CRUD suite
    // above uses the fixture's default.
    const g = await POST('/api/groups', NEW.groups({ name: 'states-probe' }));
    const res = await GET('/api/groups/states');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Number.isInteger(res.body.now), 'carries the server clock the countdown anchors on');
    assert.ok(Array.isArray(res.body.groups), 'and a group per Flatline group');
    const state = res.body.groups.find((s) => s.group_id === g.body.id);
    assert.ok(state, 'the group just created is in there');
    assert.equal(state.armed, false, 'nothing is down, so nothing is armed');

    await DELETE(`/api/groups/${g.body.id}`);
  });

  test('GET /actions/targets/:id/restore reports status rather than 404ing', async () => {
    const t = await POST('/api/actions/targets', NEW['actions/targets']());
    const res = await GET(`/api/actions/targets/${t.body.id}/restore`);
    assert.equal(res.status, 200);
    assert.equal(res.body.running, false);
    await DELETE(`/api/actions/targets/${t.body.id}`);
  });

  test('POST /actions/groups/:id/run starts a run (202)', async () => {
    const g = await POST('/api/actions/groups', NEW['actions/groups']());
    const res = await POST(`/api/actions/groups/${g.body.id}/run`);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.ok(Number.isInteger(res.body.id), 'answers with the run');
    await DELETE(`/api/actions/groups/${g.body.id}`);
  });

  test('an unknown run control 404s on its own message', async () => {
    const res = await POST('/api/actions/runs/9999/pause');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'run not found');
  });
});

// ---- validation and write guards ----

test('a payload the validator rejects is a 400, not a 500', async () => {
  const noName = await POST('/api/endpoints', { type: 'icmp', target: '127.0.0.1' });
  assert.equal(noName.status, 400);
  assert.match(noName.body.error, /name is required/);

  const badNetwork = await POST('/api/relays', NEW.relays({ network: 'not-a-cidr' }));
  assert.equal(badNetwork.status, 400);
  assert.match(badNetwork.body.error, /CIDR/);

  const badKind = await POST('/api/actions/targets', NEW['actions/targets']({ kind: 'telnet' }));
  assert.equal(badKind.status, 400);
});

test('a duplicate name is a 400 on the tables that declare it UNIQUE', async () => {
  // flatline_groups and action_groups are the two with `name TEXT NOT NULL
  // UNIQUE`; only those routes wrap their writes to turn the constraint into a
  // 400 rather than letting it surface as a 500.
  for (const name of ['groups', 'actions/groups']) {
    const first = await POST(`/api/${name}`, NEW[name]({ name: 'taken' }));
    assert.equal(first.status, 201);

    const dup = await POST(`/api/${name}`, NEW[name]({ name: 'taken' }));
    assert.equal(dup.status, 400, `${name} duplicate`);
    assert.match(dup.body.error, /already in use/);

    await DELETE(`/api/${name}/${first.body.id}`);
  }
});

// ---- what leaves the process ----

test('credentials never leave, only the names of the fields holding them', async () => {
  for (const name of ['actions/targets', 'relays', 'notifications']) {
    const created = await POST(`/api/${name}`, NEW[name]());
    const [row] = (await GET(`/api/${name}`)).body;

    assert.ok(Array.isArray(row.secret_fields), `${name} reports secret_fields`);
    assert.ok(row.secret_fields.length > 0, `${name} stored the submitted secret`);
    assert.equal(row.secret_enc, undefined, `${name} must not expose the encrypted blob`);

    assert.ok(!JSON.stringify(row).includes(SENTINEL), `${name} must not echo the secret value`);

    await DELETE(`/api/${name}/${created.body.id}`);
  }
});

// ---- methods and paths with no handler ----

test('a path or method with no handler falls through to the plain 404', async () => {
  // Not "endpoint not found" — nothing matched at all.
  const noId = await DELETE('/api/endpoints');
  assert.equal(noId.status, 404);
  assert.equal(noId.body.error, 'not found');

  // There is no fetch-one route; an existing id still gets the generic 404.
  const created = await POST('/api/endpoints', NEW.endpoints());
  const getOne = await GET(`/api/endpoints/${created.body.id}`);
  assert.equal(getOne.status, 404);
  assert.equal(getOne.body.error, 'not found');
  await DELETE(`/api/endpoints/${created.body.id}`);

  assert.equal((await GET('/api/nonsense')).status, 404);
});

// ---- the guards that sit in front of every route ----

test('mutating requests must be same-origin JSON', async () => {
  const wrongType = await fetch(`${base}/api/endpoints`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: base },
    body: '{}'
  });
  assert.equal(wrongType.status, 415);

  const crossSite = await fetch(`${base}/api/endpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: '{}'
  });
  assert.equal(crossSite.status, 403);
});

// ---- the shared/ modules the browser imports ----

test('shared modules are served to the browser', async () => {
  // shared/ is imported by server/ off disk and by the Actions page over HTTP,
  // so it is served alongside public/ — see buildStaticCache.
  for (const [file, expected] of [
    ['/shared/net.js', 'export function hostInNetwork'],
    ['/shared/restoreSecrets.js', 'export const RESTORE_SECRET_FIELDS']
  ]) {
    const res = await fetch(`${base}${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type'), /javascript/, file);
    assert.match(await res.text(), new RegExp(expected), file);
  }
});
