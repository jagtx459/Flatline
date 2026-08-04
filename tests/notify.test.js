import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

// notify.js -> db.js opens a SQLite file at import time; point it at a throwaway
// dir so the tests never touch the real data directory. Must be set before the
// dynamic import below (static imports would evaluate db.js too early).
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-test-'));
const { parseChannelConfig, checkChannelSecrets, NOTIFY_EVENTS, startNotifier } =
  await import('../server/notify.js');
const store = await import('../server/db.js');
const { encryptSecrets } = await import('../server/secrets.js');

test('parseChannelConfig accepts a valid Apprise channel', () => {
  const cfg = parseChannelConfig('apprise',
    { server_url: 'http://apprise:8000', config_key: 'home', tags: 'admin' }, [], {});
  assert.equal(typeof cfg, 'object');
  assert.equal(cfg.server_url, 'http://apprise:8000');
  assert.equal(cfg.config_key, 'home');
  assert.equal(cfg.tags, 'admin');
});

test('parseChannelConfig rejects bad Apprise input', () => {
  assert.equal(parseChannelConfig('apprise', {}, [], {}),
    'Apprise API server URL is required');
  assert.equal(parseChannelConfig('apprise', { server_url: 'ftp://x' }, [], {}),
    'server_url must be http(s)');
  assert.match(parseChannelConfig('apprise',
    { server_url: 'http://x', config_key: 'bad key!' }, [], {}), /config key/);
});

test('checkChannelSecrets requires a key or inline URLs for Apprise', () => {
  assert.equal(checkChannelSecrets('apprise', { config_key: 'home' }, {}), null);
  assert.equal(checkChannelSecrets('apprise', {}, { urls: 'discord://a/b' }), null);
  assert.match(checkChannelSecrets('apprise', {}, {}), /config key or one or more Apprise URLs/);
});

test('existing channel validation still holds', () => {
  assert.equal(checkChannelSecrets('webhook', {}, {}), 'url is required');
  const ntfy = parseChannelConfig('ntfy', { topic: 'flatline-alerts' }, [], {});
  assert.equal(ntfy.server_url, 'https://ntfy.sh'); // default filled in
});

// ---- run-level events reach a channel ----
// A recorded event has to survive the mapping in notify.js to become one of
// NOTIFY_EVENTS, so these go through a real webhook rather than asserting the
// mapping table: a wrong event key would still pass a table check.

/** Collects what a webhook channel is sent. */
let hook;
let delivered;

before(async () => {
  delivered = [];
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      delivered.push(JSON.parse(body));
      res.writeHead(200).end('{}');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  startNotifier();
});
after(() => hook.close());

/** A webhook channel subscribed to exactly `events`. */
function channel(name, events) {
  return store.createNotificationChannel({
    name, kind: 'webhook',
    config: JSON.stringify({ events }),
    secret_enc: encryptSecrets({ url: `http://127.0.0.1:${hook.address().port}/hook` }),
    enabled: 1
  });
}

/** Delivery is fire-and-forget, so give it a moment to land. */
async function settle() {
  for (let i = 0; i < 50 && delivered.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 50));
}

test('the run-level events are offered as subscriptions', () => {
  for (const ev of ['run_started', 'run_completed', 'run_failed']) {
    assert.ok(NOTIFY_EVENTS.includes(ev), `${ev} is missing from NOTIFY_EVENTS`);
    assert.deepEqual(parseChannelConfig('webhook', {}, [ev], {}).events, [ev], `${ev} is not accepted`);
  }
});

test('a finished run notifies a channel subscribed to run_completed', async () => {
  channel('completed-watcher', ['run_completed']);
  delivered = [];

  store.recordEvent({
    ts: Date.now(), kind: 'action_run_completed',
    message: '"Graceful shutdown" COMPLETED — All 3 stage(s) completed'
  });
  await settle();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event, 'run_completed', 'the recorded kind mapped to the subscribed event');
  assert.match(delivered[0].title, /Action run completed/);
  assert.match(delivered[0].message, /Graceful shutdown/);
});

test('a cancelled run counts as run_failed, and run_completed is not told', async () => {
  const failWatcher = channel('failure-watcher', ['run_failed']);
  delivered = [];

  // finish() records this kind for failed, cancelled and interrupted alike.
  store.recordEvent({
    ts: Date.now(), kind: 'action_run_failed',
    message: '"Graceful shutdown" CANCELLED — Cancelled before stage 2 of 3'
  });
  await settle();

  const names = delivered.map((d) => d.title);
  assert.equal(names.length, 1, 'only the run_failed subscriber hears about it');
  assert.equal(delivered[0].event, 'run_failed');
  assert.match(names[0], /Action run FAILED/);
  assert.match(delivered[0].message, /CANCELLED/);

  // A step-level event must not reach a run-level subscriber.
  delivered = [];
  store.recordEvent({ ts: Date.now(), kind: 'action_step_ok', message: 'one step' });
  await settle();
  assert.equal(delivered.length, 0);

  store.deleteNotificationChannel(failWatcher.id);
});
