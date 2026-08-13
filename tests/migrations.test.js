import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate, migrations } from '../server/migrations.js';

// What happens to an existing install's data when it upgrades. Each case builds
// a database at the version *before* the migration under test, writes the rows
// that version would hold, then runs migrate() and reads them back.
//
// This is deliberately not driven through db.js: that opens the real database
// at whatever version it is already on, which is the one state a migration test
// can never use.

/** A database with every migration below `version` applied, and nothing above. */
function dbAtVersion(version) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flatline-migrate-'));
  const db = new DatabaseSync(path.join(dir, 'flatline.db'));
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of migrations.filter((m) => m.version <= version).sort((a, b) => a.version - b.version)) {
    m.up(db);
  }
  db.exec(`PRAGMA user_version = ${version}`);
  return db;
}

function addTarget(db, { name, kind, config }) {
  db.prepare('INSERT INTO action_targets (name, kind, config, secret_enc, enabled, created_at) VALUES (?, ?, ?, NULL, 1, ?)')
    .run(name, kind, JSON.stringify(config), Date.now());
}

function configOf(db, name) {
  return JSON.parse(db.prepare('SELECT config FROM action_targets WHERE name = ?').get(name).config);
}

describe('migration 7: a bare restore command becomes a restore sequence', () => {
  test('an existing restore command keeps working, as the sequence\'s final step', () => {
    // restore_action defaults to 'none', so without this the target's restore
    // would quietly stop doing anything on upgrade.
    const db = dbAtVersion(6);
    addTarget(db, { name: 'nas', kind: 'ssh', config: { host: 'h', username: 'u', restore_command: 'systemctl start nfs' } });

    migrate(db);

    const cfg = configOf(db, 'nas');
    assert.equal(cfg.restore_action, 'command');
    assert.equal(cfg.restore_command, 'systemctl start nfs', 'the command itself is untouched');
    assert.equal(cfg.restore_wait_seconds, 300);
    db.close();
  });

  test('a target with no restore command gets a sequence that does nothing', () => {
    const db = dbAtVersion(6);
    addTarget(db, { name: 'esxi', kind: 'winrm', config: { host: 'h', username: 'u', command: 'shutdown' } });

    migrate(db);

    const cfg = configOf(db, 'esxi');
    assert.equal(cfg.restore_action, 'none');
    assert.equal('restore_command' in cfg, false);
    db.close();
  });

  test('auto-restore stays off', () => {
    // Nobody asked for their machines to start coming back on their own.
    const db = dbAtVersion(6);
    addTarget(db, { name: 'nas', kind: 'ssh', config: { host: 'h', username: 'u', restore_command: 'poweron' } });

    migrate(db);

    assert.equal(configOf(db, 'nas').auto_restore, 0);
    db.close();
  });

  test('http and k8s targets are left as they were', () => {
    // The sequence belongs to the kinds that get shut down and have to boot
    // again; the others' restores were already what they are now.
    const db = dbAtVersion(6);
    addTarget(db, { name: 'api', kind: 'http', config: { url: 'https://svc.local/hook', method: 'POST' } });

    migrate(db);

    assert.deepEqual(configOf(db, 'api'), { url: 'https://svc.local/hook', method: 'POST' });
    db.close();
  });

  test('a target whose config is not readable is skipped rather than failing the upgrade', () => {
    const db = dbAtVersion(6);
    db.prepare('INSERT INTO action_targets (name, kind, config, secret_enc, enabled, created_at) VALUES (?, ?, ?, NULL, 1, ?)')
      .run('broken', 'ssh', 'not json at all', Date.now());

    // The whole migration runs in a transaction — one unreadable row must not
    // roll back everyone else's upgrade.
    migrate(db);

    assert.equal(db.prepare('PRAGMA user_version').get().user_version,
      Math.max(...migrations.map((m) => m.version)));
    db.close();
  });
});

describe('migration 8: wake-on-lan relays', () => {
  test('the relays table arrives empty, and only accepts the kinds that can wake', () => {
    const db = dbAtVersion(7);
    migrate(db);

    assert.equal(db.prepare('SELECT count(*) c FROM relays').get().c, 0);

    const insert = (kind) => db.prepare(
      'INSERT INTO relays (name, kind, config, secret_enc, wake_command, network, enabled, created_at) VALUES (?, ?, ?, NULL, ?, ?, 1, ?)'
    ).run(`r-${kind}`, kind, '{}', 'wakeonlan {mac}', '10.1.20.0/24', Date.now());

    insert('ssh');
    insert('winrm');
    assert.throws(() => insert('http'), /CHECK constraint/i, 'a relay is reached like an ssh/winrm target');
    db.close();
  });
});

test('migrating an already-current database changes nothing', () => {
  const latest = Math.max(...migrations.map((m) => m.version));
  const db = dbAtVersion(latest);
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, latest);
  db.close();
});
