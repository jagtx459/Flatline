/**
 * Versioned schema migrations, tracked with SQLite's PRAGMA user_version.
 * To change the schema in a later release, append a new entry — never edit
 * an existing one. Each migration runs once, in order, inside a transaction.
 */
export const migrations = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(`
        CREATE TABLE endpoints (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          name              TEXT NOT NULL,
          type              TEXT NOT NULL CHECK (type IN ('icmp', 'http')),
          target            TEXT NOT NULL,
          interval_seconds  INTEGER NOT NULL DEFAULT 30,
          timeout_ms        INTEGER NOT NULL DEFAULT 5000,
          down_threshold    INTEGER NOT NULL DEFAULT 3,
          up_threshold      INTEGER NOT NULL DEFAULT 2,
          expect_status     INTEGER,
          expect_json       TEXT,
          enabled           INTEGER NOT NULL DEFAULT 1,
          last_state        TEXT NOT NULL DEFAULT 'unknown',
          last_change_ts    INTEGER,
          created_at        INTEGER NOT NULL
        );

        CREATE TABLE checks (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
          ts          INTEGER NOT NULL,
          ok          INTEGER NOT NULL,
          latency_ms  REAL,
          status_code INTEGER,
          error       TEXT
        );
        CREATE INDEX idx_checks_endpoint_ts ON checks (endpoint_id, ts);

        CREATE TABLE events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          ts          INTEGER NOT NULL,
          endpoint_id INTEGER REFERENCES endpoints(id) ON DELETE CASCADE,
          kind        TEXT NOT NULL,
          from_state  TEXT,
          to_state    TEXT,
          message     TEXT
        );
        CREATE INDEX idx_events_ts ON events (ts);

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        -- Flatline groups: a failure condition (all/any of a set of
        -- endpoints down) that arms a countdown and, after a grace period,
        -- triggers the action groups assigned to it.
        CREATE TABLE flatline_groups (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT NOT NULL UNIQUE,
          grace_minutes INTEGER NOT NULL DEFAULT 5,
          mode          TEXT NOT NULL DEFAULT 'all' CHECK (mode IN ('all', 'any')),
          enabled       INTEGER NOT NULL DEFAULT 1,
          created_at    INTEGER NOT NULL
        );

        CREATE TABLE flatline_group_endpoints (
          flatline_group_id INTEGER NOT NULL REFERENCES flatline_groups(id) ON DELETE CASCADE,
          endpoint_id       INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
          PRIMARY KEY (flatline_group_id, endpoint_id)
        );

        -- Action targets: a machine or service, and exactly what runs on it
        -- when triggered (SSH/RDP command, K8s drain/scale, HTTP request).
        CREATE TABLE action_targets (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          kind       TEXT NOT NULL CHECK (kind IN ('ssh', 'rdp', 'k8s', 'http')),
          config     TEXT NOT NULL DEFAULT '{}',
          secret_enc TEXT,
          enabled    INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );

        -- Action groups: an ordered sequence of action-target steps, with a
        -- policy for what happens when a step fails.
        CREATE TABLE action_groups (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL UNIQUE,
          on_failure TEXT NOT NULL DEFAULT 'continue',
          enabled    INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE action_group_members (
          action_group_id INTEGER NOT NULL REFERENCES action_groups(id) ON DELETE CASCADE,
          target_id       INTEGER NOT NULL REFERENCES action_targets(id) ON DELETE CASCADE,
          position        INTEGER NOT NULL DEFAULT 0,
          timeout_seconds INTEGER NOT NULL DEFAULT 60,
          PRIMARY KEY (action_group_id, target_id)
        );

        CREATE TABLE flatline_group_actions (
          flatline_group_id INTEGER NOT NULL REFERENCES flatline_groups(id) ON DELETE CASCADE,
          action_group_id   INTEGER NOT NULL REFERENCES action_groups(id) ON DELETE CASCADE,
          PRIMARY KEY (flatline_group_id, action_group_id)
        );

        -- Notification channels: config holds non-secret fields plus
        -- events[] and title/body templates; secret_enc is the same
        -- encrypted-blob format action targets use (see secrets.js).
        CREATE TABLE notification_channels (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          kind       TEXT NOT NULL CHECK (kind IN ('webhook', 'discord', 'ntfy', 'email')),
          config     TEXT NOT NULL DEFAULT '{}',
          secret_enc TEXT,
          enabled    INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    name: 'rename action target kind rdp -> winrm',
    up(db) {
      // The kind was always WinRM under the hood; drop the historical 'rdp'
      // name. SQLite can't alter a CHECK constraint in place, so the table is
      // rebuilt: build the replacement under a temp name, drop the original,
      // then rename the replacement into its place. Dropping the original
      // (foreign_keys is ON) cascades through action_group_members.target_id
      // and empties it, so those rows are backed up first and restored after —
      // target ids are preserved, so the references stay valid. Renaming the
      // replacement INTO 'action_targets' (rather than renaming the original
      // out) keeps action_group_members' foreign-key text resolving correctly.
      db.exec(`
        CREATE TEMP TABLE action_group_members_backup AS SELECT * FROM action_group_members;

        CREATE TABLE action_targets_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          kind       TEXT NOT NULL CHECK (kind IN ('ssh', 'winrm', 'k8s', 'http')),
          config     TEXT NOT NULL DEFAULT '{}',
          secret_enc TEXT,
          enabled    INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
        INSERT INTO action_targets_new (id, name, kind, config, secret_enc, enabled, created_at)
          SELECT id, name, CASE WHEN kind = 'rdp' THEN 'winrm' ELSE kind END,
                 config, secret_enc, enabled, created_at
          FROM action_targets;
        DROP TABLE action_targets;
        ALTER TABLE action_targets_new RENAME TO action_targets;

        DELETE FROM action_group_members;
        INSERT INTO action_group_members SELECT * FROM action_group_members_backup;
        DROP TABLE action_group_members_backup;
      `);
    }
  }
];

export function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const m of pending) {
    db.exec('BEGIN');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      console.log(`[db] applied migration ${m.version}: ${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed: ${err.message}`, { cause: err });
    }
  }
}
