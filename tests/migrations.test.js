import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// What happens to an existing install's data when it upgrades. Each case builds
// a database at the version *before* the migration under test, writes the rows
// that version would hold, then runs migrate() and reads them back.
//
// This is deliberately not driven through db.js: that opens the real database
// at whatever version it is already on, which is the one state a migration test
// can never use.
//
// Migration 10 re-encrypts a credential under a new name, so secrets.js is in
// play — point its key file at a throwaway dir before the dynamic import, or it
// would generate one next to the real database.
process.env.FLATLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'flatline-migrate-key-'));
const { migrate, migrations } = await import('../server/migrations.js');
const { encryptSecrets, decryptSecrets } = await import('../server/secrets.js');

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

function addTarget(db, { name, kind, config, secret_enc = null }) {
  db.prepare('INSERT INTO action_targets (name, kind, config, secret_enc, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(name, kind, JSON.stringify(config), secret_enc, Date.now());
}

function configOf(db, name) {
  return JSON.parse(db.prepare('SELECT config FROM action_targets WHERE name = ?').get(name).config);
}

/** One target upgraded from `version` to current, and the config it ends with. */
function upgraded(version, kind, config) {
  const db = dbAtVersion(version);
  addTarget(db, { name: 't', kind, config });
  migrate(db);
  const cfg = configOf(db, 't');
  db.close();
  return cfg;
}

describe('migrations 7, 9 and 10: a bare restore command becomes a post-restore action', () => {
  test('an existing restore command still runs, over the target\'s own connection', () => {
    // Three migrations in sequence: 7 gave the command a restore_action, 9 turned
    // that into a method, 10 moved it behind the restore into step 3. Without any
    // of them, the target's restore would quietly stop doing anything on upgrade.
    const cfg = upgraded(6, 'ssh', { host: 'h', username: 'u', restore_command: 'systemctl start nfs' });
    assert.equal(cfg.restore_enabled, 1);
    assert.equal(cfg.post_restore_kind, 'ssh');
    assert.equal(cfg.post_restore_inherit, 1, 'a command always ran over the target\'s own connection');
    assert.equal(cfg.post_restore_command, 'systemctl start nfs', 'the command itself is untouched');
    assert.equal(cfg.restore_wait_seconds, 300);
    assert.equal('restore_action' in cfg, false, 'replaced by the two step kinds');
  });

  test('a target with nothing to restore ends with the restore switched off', () => {
    const cfg = upgraded(6, 'winrm', { host: 'h', username: 'u', command: 'shutdown' });
    assert.equal(cfg.restore_enabled, 0);
    assert.equal(cfg.post_restore_kind, 'none');
    assert.equal('restore_command' in cfg, false);
  });

  test('auto-restore stays off', () => {
    // Nobody asked for their machines to start coming back on their own.
    assert.equal(upgraded(6, 'ssh', { host: 'h', username: 'u', restore_command: 'poweron' }).auto_restore, 0);
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

describe('migration 9: restore method is chosen, not inherited from the target kind', () => {
  test("an ssh restore that sent an HTTP request keeps its own auth", () => {
    // That step always authenticated separately from the host login, so it
    // becomes an http method that does not inherit — the fields it carried are
    // already under the names the new model uses.
    const cfg = upgraded(8, 'ssh', {
      host: 'h', username: 'u', restore_action: 'http',
      restore_url: 'https://svc.local/resume', restore_method: 'POST',
      restore_auth_scheme: 'bearer'
    });
    assert.equal(cfg.restore_enabled, 1);
    assert.equal(cfg.restore_kind, 'http');
    assert.equal(cfg.restore_inherit, 0);
    assert.equal(cfg.restore_url, 'https://svc.local/resume');
    assert.equal(cfg.restore_auth_scheme, 'bearer');
  });

  test('a wake with no final step becomes a wake with nothing behind it', () => {
    const cfg = upgraded(8, 'winrm', {
      host: 'h', username: 'u', restore_action: 'none', wol_mac: 'AA:BB:CC:DD:EE:FF'
    });
    assert.equal(cfg.restore_enabled, 1);
    assert.equal(cfg.restore_kind, 'wol');
    assert.equal(cfg.post_restore_kind, 'none');
    assert.equal(cfg.wol_mac, 'AA:BB:CC:DD:EE:FF');
  });

  test('a drained cluster gets written down the uncordon that used to be implied', () => {
    // It was inferred from the trigger action rather than stored. It is an
    // explicit choice now, so the migration records what was happening.
    const cfg = upgraded(8, 'k8s', { api_url: 'https://10.0.0.1:6443', action: 'drain' });
    assert.equal(cfg.restore_enabled, 1);
    assert.equal(cfg.restore_kind, 'k8s');
    assert.equal(cfg.restore_inherit, 1);
    assert.equal(cfg.restore_uncordon, 1);
  });

  test('a custom cluster target that undid nothing ends with no restore', () => {
    const cfg = upgraded(8, 'k8s', {
      api_url: 'https://10.0.0.1:6443', action: 'custom', command_path: '/apis/x'
    });
    assert.equal(cfg.restore_enabled, 0);
    assert.equal(cfg.post_restore_kind, 'none');
  });

  test('an http target restores over http when it had a URL, and not at all otherwise', () => {
    const withUndo = upgraded(8, 'http', {
      url: 'https://svc.local/hook', restore_url: 'https://svc.local/resume', auto_restore: 1
    });
    assert.equal(withUndo.restore_enabled, 1);
    assert.equal(withUndo.restore_kind, 'http');
    assert.equal(withUndo.restore_inherit, 1);
    assert.equal(withUndo.auto_restore, 1, 'a target already restoring on its own keeps doing so');

    const without = upgraded(8, 'http', { url: 'https://svc.local/hook', auto_restore: 1 });
    assert.equal(without.restore_enabled, 0);
    assert.equal(without.auto_restore, 0, 'nothing to arm');
  });
});

describe('migration 10: the restore splits into a restore step and a post-restore action', () => {
  test('a shell restore moves behind the wake it already ran after', () => {
    const cfg = upgraded(9, 'ssh', {
      host: 'h', username: 'u', restore_enabled: 1, restore_kind: 'ssh', restore_inherit: 1,
      wol_mac: 'AA:BB:CC:DD:EE:FF', restore_command: 'systemctl start nfs'
    });
    assert.equal(cfg.restore_kind, 'wol');
    assert.equal(cfg.restore_inherit, 0);
    assert.equal(cfg.wol_mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(cfg.post_restore_kind, 'ssh');
    assert.equal(cfg.post_restore_inherit, 1);
    assert.equal(cfg.post_restore_command, 'systemctl start nfs');
    assert.equal('restore_command' in cfg, false, 'the old name is gone');
  });

  test('a shell restore with no wake becomes a wake with no MAC to send', () => {
    // Which is how "the machine is already up, just run the command" is said
    // now. Nothing about what it does changes.
    const cfg = upgraded(9, 'http', {
      url: 'https://svc.local/hook', restore_enabled: 1, restore_kind: 'winrm', restore_inherit: 0,
      restore_host: '10.0.0.9', restore_port: 5985, restore_username: 'admin',
      restore_command: 'Restart-Service app'
    });
    assert.equal(cfg.restore_kind, 'wol');
    assert.equal('wol_mac' in cfg, false);
    assert.equal(cfg.post_restore_kind, 'winrm');
    assert.equal(cfg.post_restore_host, '10.0.0.9');
    assert.equal(cfg.post_restore_port, 5985);
    assert.equal(cfg.post_restore_username, 'admin');
    assert.equal(cfg.post_restore_command, 'Restart-Service app');
  });

  test('a shell restore\'s own credentials are re-encrypted under their new names', () => {
    // They would otherwise be unreachable: the step that reads them now looks
    // for post_restore_ names, and secretFieldsFor would drop the old ones on
    // the next save.
    const db = dbAtVersion(9);
    addTarget(db, {
      name: 't', kind: 'http',
      config: {
        url: 'https://svc.local/hook', restore_enabled: 1, restore_kind: 'ssh', restore_inherit: 0,
        restore_host: '10.0.0.9', restore_username: 'admin', restore_command: 'systemctl start app'
      },
      secret_enc: encryptSecrets({ token: 'target-tok', restore_password: 'shell-pw' })
    });
    migrate(db);

    const { secret_enc } = db.prepare('SELECT secret_enc FROM action_targets WHERE name = ?').get('t');
    const secrets = decryptSecrets(secret_enc);
    db.close();

    assert.equal(secrets.post_restore_password, 'shell-pw');
    assert.equal('restore_password' in secrets, false);
    assert.equal(secrets.token, 'target-tok', 'the target\'s own credentials are untouched');
  });

  test('a cluster or endpoint restore keeps its fields exactly where they were', () => {
    // Both are still step-1 methods, so nothing about them moves.
    const cluster = upgraded(9, 'k8s', {
      api_url: 'https://10.0.0.1:6443', restore_enabled: 1, restore_kind: 'k8s', restore_inherit: 1,
      restore_uncordon: 1, restore_restart_deployments: 1
    });
    assert.equal(cluster.restore_kind, 'k8s');
    assert.equal(cluster.restore_inherit, 1);
    assert.equal(cluster.restore_uncordon, 1);
    assert.equal(cluster.post_restore_kind, 'none');

    const endpoint = upgraded(9, 'http', {
      url: 'https://svc.local/hook', restore_enabled: 1, restore_kind: 'http', restore_inherit: 1,
      restore_url: 'https://svc.local/resume', restore_method: 'POST'
    });
    assert.equal(endpoint.restore_kind, 'http');
    assert.equal(endpoint.restore_url, 'https://svc.local/resume');
    assert.equal(endpoint.post_restore_kind, 'none');
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
