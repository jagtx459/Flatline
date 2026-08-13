import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// db.js opens a SQLite file at import time — point it at a throwaway dir so the
// tests never touch the real data directory. Must be set before the dynamic
// import (a static import would evaluate db.js too early).
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-test-'));
const store = await import('../server/db.js');
const { encryptSecrets, decryptSecrets, rotateKey } = await import('../server/secrets.js');

/** Builds a small but relational config: endpoint -> flatline group -> action group -> target. */
function seed() {
  const ep = store.createEndpoint({
    name: 'web', type: 'http', target: 'https://example.com',
    interval_seconds: 30, timeout_ms: 5000, down_threshold: 3, up_threshold: 2,
    expect_status: 200, expect_json: null, enabled: 1
  });
  const target = store.createActionTarget({
    name: 'shutdown-host', kind: 'ssh',
    config: JSON.stringify({ host: 'h', username: 'u', port: 22, auth_method: 'password', command: 'poweroff' }),
    secret_enc: null, enabled: 1
  });
  const ag = store.createActionGroup({
    name: 'graceful', on_failure: 'continue', enabled: 1,
    stages: [
      { pass_rule: 'any', on_failure: null, wait_seconds: 0,
        steps: [{ target_id: target.id, timeout_seconds: 60 }] },
      // A wait step and a non-default gap, so the export carries both.
      { pass_rule: 'any', on_failure: null, wait_seconds: 20, steps: [{ wait_seconds: 90 }] }
    ]
  });
  const fg = store.createFlatlineGroup({
    name: 'grid', grace_minutes: 5, mode: 'all', enabled: 1,
    action_group_ids: [ag.id], endpoint_ids: [ep.id]
  });
  store.createNotificationChannel({
    name: 'discord', kind: 'discord',
    config: JSON.stringify({ events: ['group_triggered'] }), secret_enc: null, enabled: 1
  });
  // A relay carries an encrypted credential of its own, so the transfer paths
  // have to treat it like an action target rather than like plain config.
  const relay = store.createRelay({
    name: 'garage-pi', kind: 'ssh',
    config: JSON.stringify({ host: '10.1.20.5', username: 'pi', port: 22, auth_method: 'password' }),
    wake_command: 'wakeonlan {mac}', network: '10.1.20.0/24',
    secret_enc: encryptSecrets({ password: 'relay-pw' }), enabled: 1
  });
  return { ep, target, ag, fg, relay };
}

test('exportConfig -> replaceConfig -> exportConfig round-trips', () => {
  seed();
  const first = store.exportConfig();

  // Replacing with the same payload must leave an identical export (ids and all).
  const counts = store.replaceConfig({ flatline_config: 1, ...first });
  assert.equal(counts.endpoints, 1);
  assert.equal(counts.action_targets, 1);
  assert.equal(counts.notification_channels, 1);

  const second = store.exportConfig();
  assert.deepEqual(second, first);
});

test('export includes the relational join rows', () => {
  const cfg = store.exportConfig();
  assert.equal(cfg.flatline_group_endpoints.length, 1);
  assert.equal(cfg.flatline_group_actions.length, 1);
  assert.equal(cfg.action_group_members.length, 2);
});

test('export carries the waits, so an imported group keeps its timing', () => {
  const cfg = store.exportConfig();
  assert.deepEqual(cfg.action_group_stages.map((s) => s.wait_seconds), [0, 20]);
  // The wait step travels as a member with no target and a duration of its own.
  const wait = cfg.action_group_members.find((m) => m.target_id === null);
  assert.equal(wait.wait_seconds, 90);
});

test('a relay survives export and import with its credential intact', () => {
  // The blob travels verbatim, so it only decrypts on an instance holding the
  // same key — but it must arrive byte-for-byte, or the relay is unusable.
  const before = store.listRelays()[0];
  const cfg = store.exportConfig();
  assert.equal(cfg.relays.length, 1);

  store.replaceConfig({ flatline_config: 1, ...cfg });

  const after = store.listRelays()[0];
  assert.equal(after.secret_enc, before.secret_enc);
  assert.deepEqual(decryptSecrets(after.secret_enc), { password: 'relay-pw' });
  // The two fields that make a relay a relay, and are on no other table.
  assert.equal(after.wake_command, 'wakeonlan {mac}');
  assert.equal(after.network, '10.1.20.0/24');
});

test('rotating the key re-encrypts relay credentials too', () => {
  // A relay's secret lives in its own table; a rotation that walked only
  // action_targets and notification_channels would leave it decryptable by a
  // key that is meant to be retired.
  const relay = store.listRelays()[0];
  const oldBlob = relay.secret_enc;

  rotateKey(Buffer.alloc(32, 7), (reencrypt) => {
    const rows = store.allEncryptedRows().map((r) => ({ ...r, secret_enc: reencrypt(r.secret_enc) }));
    store.updateEncryptedRows(rows);
  });

  const after = store.listRelays()[0];
  assert.notEqual(after.secret_enc, oldBlob, 'the stored ciphertext changed');
  assert.deepEqual(decryptSecrets(after.secret_enc), { password: 'relay-pw' }, 'and still decrypts');
});

test('replaceConfig rejects a file without the marker', () => {
  assert.throws(() => store.replaceConfig({ endpoints: [] }), /flatline_config marker/);
});

test('replaceConfig rejects a malformed table and does not wipe existing config', () => {
  const before = store.exportConfig();
  assert.throws(() => store.replaceConfig({ flatline_config: 1, endpoints: 'nope' }), /must be an array/);
  assert.deepEqual(store.exportConfig(), before); // rolled back / untouched
});

test('settings marked portable round-trip; others are excluded', () => {
  store.setSetting('retention_days', '9');
  store.setSetting('auth_password_hash', 's1:deadbeef:cafe');
  const cfg = store.exportConfig();
  assert.equal(cfg.settings.retention_days, '9');
  assert.ok(!('auth_password_hash' in cfg.settings));
});

test('resetAll wipes config, history, and security back to a fresh install', () => {
  store.resetAll(); // clear state left by earlier tests so seed() names are free
  const { ep } = seed();
  store.recordCheck(ep.id, { ts: Date.now(), ok: 1, latencyMs: 5 });
  store.recordEvent({ ts: Date.now(), kind: 'state', message: 'x' });
  store.setSetting('auth_password_hash', 's1:deadbeef:cafe');
  store.setSetting('allowed_hosts', 'flatline.lan');
  store.setSetting('retention_days', '3');

  store.resetAll();

  const cfg = store.exportConfig();
  for (const [k, v] of Object.entries(cfg)) {
    if (Array.isArray(v)) assert.equal(v.length, 0, `${k} should be empty`);
  }
  assert.equal(store.db.prepare('SELECT count(*) c FROM checks').get().c, 0);
  assert.equal(store.db.prepare('SELECT count(*) c FROM events').get().c, 0);

  const s = store.getSettings();
  assert.ok(!('auth_password_hash' in s));      // password removed → auth off
  assert.ok(!('allowed_hosts' in s));           // cleared
  assert.equal(s.retention_days, '14');         // back to default
  assert.equal(s.grace_minutes, '5');
});

test('applyRestore swaps in an uploaded backup and reopens the connection', () => {
  store.resetAll();
  const { ep } = seed();
  store.checkpoint(); // fold WAL into the main file so the copy is complete

  // Snapshot the current DB, then change the live DB after the snapshot.
  const snapshot = path.join(store.dataDir, 'snapshot.db');
  copyFileSync(store.dbFile, snapshot);
  store.deleteEndpoint(ep.id);
  assert.equal(store.listEndpoints().length, 0);

  // Restore the snapshot: stream it into the temp file, then apply.
  copyFileSync(snapshot, store.restoreTmpFile);
  store.applyRestore();

  // The reopened connection serves the snapshot's data.
  const eps = store.listEndpoints();
  assert.equal(eps.length, 1);
  assert.equal(eps[0].name, 'web');
  // And the connection is live — a write still works.
  store.setSetting('retention_days', '7');
  assert.equal(store.getSettings().retention_days, '7');
});

test('applyRestore rejects a non-SQLite upload without disturbing the live DB', () => {
  store.resetAll();
  seed();
  writeFileSync(store.restoreTmpFile, 'definitely not a database');
  assert.throws(() => store.applyRestore(), /not a valid SQLite database/);
  assert.equal(store.listEndpoints().length, 1); // untouched, still queryable
});
