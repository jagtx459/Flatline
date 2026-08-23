import { decryptSecrets, encryptSecrets } from './secrets.js';

/**
 * Versioned schema migrations, tracked with SQLite's PRAGMA user_version.
 * To change the schema in a later release, append a new entry — never edit
 * an existing one. Each migration runs once, in order, inside a transaction.
 *
 * secrets.js is imported for the one migration that renames a stored credential
 * (10). It reads only paths.js, not db.js, so importing this module still costs
 * nothing but the key file's location.
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
  },
  {
    version: 3,
    name: 'group action-group steps into stages',
    up(db) {
      // An action group is now an ordered list of stages; the steps in a stage
      // run simultaneously. A stage decides on its own whether it counts as
      // failed (pass_rule: 'any' = fail if any step fails, 'all' = fail only if
      // every step fails) and what that means for the rest of the sequence
      // (on_failure; NULL inherits the action group's on_failure).
      db.exec(`
        CREATE TABLE action_group_stages (
          action_group_id INTEGER NOT NULL REFERENCES action_groups(id) ON DELETE CASCADE,
          stage           INTEGER NOT NULL,
          pass_rule       TEXT NOT NULL DEFAULT 'any' CHECK (pass_rule IN ('any', 'all')),
          on_failure      TEXT CHECK (on_failure IN ('stop', 'continue')),
          PRIMARY KEY (action_group_id, stage)
        );

        ALTER TABLE action_group_members ADD COLUMN stage INTEGER NOT NULL DEFAULT 0;

        -- Preserve today's behaviour: each existing step becomes its own
        -- single-step stage, so groups keep running strictly top to bottom.
        -- position already numbers a group's steps 0..n-1, so reuse it.
        UPDATE action_group_members SET stage = position;
        INSERT INTO action_group_stages (action_group_id, stage, pass_rule, on_failure)
          SELECT action_group_id, position, 'any', NULL FROM action_group_members;
      `);
    }
  },
  {
    version: 4,
    name: 'allow a target to be reused across stages',
    up(db) {
      // Widen the members primary key from (group, target) to (group, target,
      // stage) so the same target can appear in more than one stage — still at
      // most once per stage. SQLite can't alter a PK in place, so the table is
      // rebuilt. Nothing has a foreign key to action_group_members, so dropping
      // it cascades nowhere; the reinserted rows still reference live groups and
      // targets, so those foreign keys stay valid.
      db.exec(`
        CREATE TABLE action_group_members_new (
          action_group_id INTEGER NOT NULL REFERENCES action_groups(id) ON DELETE CASCADE,
          target_id       INTEGER NOT NULL REFERENCES action_targets(id) ON DELETE CASCADE,
          position        INTEGER NOT NULL DEFAULT 0,
          timeout_seconds INTEGER NOT NULL DEFAULT 60,
          stage           INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (action_group_id, target_id, stage)
        );
        INSERT INTO action_group_members_new
            (action_group_id, target_id, position, timeout_seconds, stage)
          SELECT action_group_id, target_id, position, timeout_seconds, stage
          FROM action_group_members;
        DROP TABLE action_group_members;
        ALTER TABLE action_group_members_new RENAME TO action_group_members;
      `);
    }
  },
  {
    version: 5,
    name: 'record action group runs',
    up(db) {
      // One row per execution of an action group, so the dashboard can show
      // what is running (and what ran) across a restart. The action group's
      // name is snapshotted alongside the id: the id goes NULL if the group is
      // later deleted, but the history still reads correctly.
      //
      // 'interrupted' is the status a run is left in when the process stops
      // mid-run — nothing can report its outcome after that.
      db.exec(`
        CREATE TABLE action_runs (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          action_group_id   INTEGER REFERENCES action_groups(id) ON DELETE SET NULL,
          action_group_name TEXT NOT NULL,
          trigger           TEXT NOT NULL CHECK (trigger IN ('flatline', 'manual')),
          trigger_detail    TEXT,
          status            TEXT NOT NULL CHECK (status IN
                              ('running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted')),
          stage_index       INTEGER NOT NULL DEFAULT 0,
          stage_count       INTEGER NOT NULL DEFAULT 0,
          steps             TEXT NOT NULL DEFAULT '[]',
          started_at        INTEGER NOT NULL,
          estimated_end_ts  INTEGER,
          ended_at          INTEGER,
          message           TEXT
        );
        CREATE INDEX idx_action_runs_started ON action_runs (started_at);
      `);
    }
  },
  {
    version: 6,
    name: 'waits between stages and wait steps within a stage',
    up(db) {
      // Two kinds of deliberate pause:
      //
      // action_group_stages.wait_seconds — the gap held open BEFORE that stage
      // starts (ignored for the first stage, which must not delay the response
      // to an outage). Existing groups get the 5s default, so a sequence that
      // used to slam its stages together now breathes between them.
      //
      // A wait step — an action_group_members row with no target_id and a
      // wait_seconds instead. It runs alongside the stage's other steps and
      // holds the stage open for that long. target_id therefore becomes
      // nullable, and the primary key moves off it: (group, stage, position)
      // already identifies a step, and position is unique within a stage in
      // both the migration-3 rows (one per stage) and everything written since.
      db.exec(`
        ALTER TABLE action_group_stages ADD COLUMN wait_seconds INTEGER NOT NULL DEFAULT 5;

        CREATE TABLE action_group_members_new (
          action_group_id INTEGER NOT NULL REFERENCES action_groups(id) ON DELETE CASCADE,
          target_id       INTEGER REFERENCES action_targets(id) ON DELETE CASCADE,
          position        INTEGER NOT NULL DEFAULT 0,
          timeout_seconds INTEGER NOT NULL DEFAULT 60,
          stage           INTEGER NOT NULL DEFAULT 0,
          wait_seconds    INTEGER,
          PRIMARY KEY (action_group_id, stage, position),
          -- a step acts on a target or waits, never both and never neither
          CHECK ((target_id IS NULL) <> (wait_seconds IS NULL))
        );
        INSERT INTO action_group_members_new
            (action_group_id, target_id, position, timeout_seconds, stage, wait_seconds)
          SELECT action_group_id, target_id, position, timeout_seconds, stage, NULL
          FROM action_group_members;
        DROP TABLE action_group_members;
        ALTER TABLE action_group_members_new RENAME TO action_group_members;
      `);
    }
  },
  {
    version: 7,
    name: 'ssh/winrm restore command becomes a restore sequence',
    up(db) {
      // Restore for ssh/winrm is now a sequence — an optional Wake-on-LAN
      // packet, a wait for the host to answer, then a final step chosen by
      // restore_action. An existing target only has a bare restore_command, and
      // restore_action defaults to 'none', so without this its restore would
      // quietly stop doing anything. Auto-restore stays off: nobody asked for
      // their machines to start coming back on their own.
      const rows = db.prepare(
        "SELECT id, config FROM action_targets WHERE kind IN ('ssh', 'winrm')"
      ).all();
      const update = db.prepare('UPDATE action_targets SET config = ? WHERE id = ?');

      for (const row of rows) {
        let config;
        try { config = JSON.parse(row.config); } catch { continue; }
        if (typeof config !== 'object' || config === null) continue;

        config.auto_restore = 0;
        config.restore_wait_seconds = 300;
        config.restore_action = config.restore_command ? 'command' : 'none';
        update.run(JSON.stringify(config), row.id);
      }
    }
  },
  {
    version: 8,
    name: 'wake-on-lan relays',
    up(db) {
      // A relay is a machine that already sits on the target's LAN, which
      // Flatline can reach and ask to broadcast a magic packet. It exists
      // because a broadcast never crosses a router: a target on another VLAN
      // is unreachable by Wake-on-LAN from Flatline itself, however the
      // firewall is configured.
      //
      // Same shape as an action target — a connection plus encrypted
      // credentials — minus everything about shutting down, since a relay is
      // only ever asked to wake something. wake_command is a template holding
      // {mac}: what to install and what to run differ per box (wakeonlan vs
      // wol vs a PowerShell one-liner), while the MAC belongs to the target
      // being woken, so one relay serves every host on its LAN.
      //
      // network is the broadcast domain the relay can actually reach, as CIDR
      // (10.1.20.0/24). A relay only helps for targets inside it, and picking
      // the wrong one fails silently — nothing ever answers a magic packet —
      // so the UI checks the target's address against this and warns.
      db.exec(`
        CREATE TABLE relays (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT NOT NULL,
          kind         TEXT NOT NULL CHECK (kind IN ('ssh', 'winrm')),
          config       TEXT NOT NULL,
          secret_enc   TEXT,
          wake_command TEXT NOT NULL,
          network      TEXT NOT NULL,
          enabled      INTEGER NOT NULL DEFAULT 1,
          created_at   INTEGER NOT NULL
        );
      `);
    }
  },
  {
    version: 9,
    name: 'restore method is chosen, not inherited from the target kind',
    up(db) {
      // Restore used to be whatever shape the target's kind implied: only
      // ssh/winrm could wake a host, only a k8s target could uncordon, and an
      // http target could do nothing but replay one request. A restore is now a
      // wake + wait + one action whose method (restore_kind) is picked
      // independently, connecting either to the target itself (restore_inherit)
      // or somewhere of its own.
      //
      // Every existing restore maps onto the new shape unchanged, so nothing
      // needs reconfiguring: what a target did before is what it still does.
      // restore_enabled is set from whether the old config would actually have
      // done anything — the same test the Restore button used to enable itself
      // with — so a target that was never set up does not silently acquire one.
      const rows = db.prepare('SELECT id, kind, config FROM action_targets').all();
      const update = db.prepare('UPDATE action_targets SET config = ? WHERE id = ?');

      for (const row of rows) {
        let config;
        try { config = JSON.parse(row.config); } catch { continue; }
        if (typeof config !== 'object' || config === null) continue;

        if (row.kind === 'ssh' || row.kind === 'winrm') {
          // wake -> wait -> (nothing | command on the host | an HTTP request).
          // The HTTP option already carried its own URL, auth and secrets under
          // restore_ names, which are exactly the names it keeps.
          const action = config.restore_action ?? 'none';
          config.restore_enabled = (config.wol_mac || action !== 'none') ? 1 : 0;
          config.restore_kind = action === 'http' ? 'http' : action === 'command' ? row.kind : 'none';
          // A command ran over the target's own connection; an HTTP request
          // never did — it authenticated separately by design.
          config.restore_inherit = action === 'command' ? 1 : 0;
          delete config.restore_action;
        } else if (row.kind === 'k8s') {
          const uncordoning = config.action !== 'custom' || !!config.restore_uncordon;
          config.restore_enabled = (uncordoning || config.restore_path || config.restore_restart_deployments) ? 1 : 0;
          config.restore_kind = 'k8s';
          config.restore_inherit = 1;
          // Was implied by a 'drain' target rather than stored; it is an
          // explicit choice now, so write down what was actually happening.
          config.restore_uncordon = uncordoning ? 1 : 0;
        } else if (row.kind === 'http') {
          config.restore_enabled = config.restore_url ? 1 : 0;
          config.restore_kind = config.restore_url ? 'http' : 'none';
          config.restore_inherit = 1;
        }

        if (!config.restore_enabled) {
          config.auto_restore = 0;
          config.restore_kind = 'none';
          config.restore_inherit = 0;
        }
        update.run(JSON.stringify(config), row.id);
      }
    }
  },
  {
    version: 10,
    name: 'a restore is a restore step, a wait, and an optional post-restore action',
    up(db) {
      // The single restore action splits in two. Step 1 is now only what can
      // bring something back from nothing — a wake, a cluster, or an endpoint
      // that resumes the service — and a shell command, which needs the machine
      // to already be answering, moves to the optional step 3 that runs after
      // the wait. Step 3 carries its own connection and credentials under
      // post_restore_ names, so both steps can talk to different places.
      //
      // Every existing restore maps onto the new shape unchanged: a command that
      // ran after a wake still runs after that wake, and one configured without
      // a wake becomes a wake with no MAC to send, which skips straight to it.
      const SHELL_CONFIG = ['host', 'port', 'domain', 'username', 'auth_method', 'command'];
      const SHELL_SECRETS = ['password', 'private_key', 'passphrase', 'sudo_password'];

      /** The step-3 credentials of a shell restore that brought its own
       *  connection, under their new names. A blob that will not decrypt (a lost
       *  or rotated key) is left exactly as it is — there is nothing readable in
       *  it to rename, and nothing to gain by discarding it. */
      const renameSecrets = (blob) => {
        if (!blob) return blob;
        let secrets;
        try { secrets = decryptSecrets(blob); } catch { return blob; }
        let renamed = false;
        for (const field of SHELL_SECRETS) {
          if (!(`restore_${field}` in secrets)) continue;
          secrets[`post_restore_${field}`] = secrets[`restore_${field}`];
          delete secrets[`restore_${field}`];
          renamed = true;
        }
        return renamed ? encryptSecrets(secrets) : blob;
      };

      const rows = db.prepare('SELECT id, config, secret_enc FROM action_targets').all();
      const update = db.prepare('UPDATE action_targets SET config = ?, secret_enc = ? WHERE id = ?');

      for (const row of rows) {
        let config;
        try { config = JSON.parse(row.config); } catch { continue; }
        if (typeof config !== 'object' || config === null) continue;

        const was = config.restore_kind ?? 'none';
        let secretEnc = row.secret_enc;

        if (was === 'ssh' || was === 'winrm') {
          config.post_restore_kind = was;
          config.post_restore_inherit = config.restore_inherit ?? 0;
          for (const field of SHELL_CONFIG) {
            if (!(`restore_${field}` in config)) continue;
            config[`post_restore_${field}`] = config[`restore_${field}`];
            delete config[`restore_${field}`];
          }
          config.restore_kind = 'wol';
          config.restore_inherit = 0;
          secretEnc = renameSecrets(row.secret_enc);
        } else {
          // 'none' was a wake with nothing behind it, which is what the wake
          // method is now; k8s and http keep their fields and their names.
          config.restore_kind = was === 'none' ? 'wol' : was;
          config.post_restore_kind = 'none';
          config.post_restore_inherit = 0;
        }
        update.run(JSON.stringify(config), secretEnc, row.id);
      }
    }
  },
  {
    version: 11,
    name: 'an action group can stop once its Flatline group recovers',
    up(db) {
      // A run triggered by a Flatline group can now be told to give up the rest
      // of its stages the moment that group is back — power returned mid-way,
      // so there is nothing left to shut down. Off by default: every existing
      // group keeps running to the end, as it always has.
      //
      // Nullable rather than NOT NULL, unlike the other flags: a config file
      // exported before this column existed has no value to import, and NULL
      // reads as off, which is exactly what such a group was.
      db.exec(`
        ALTER TABLE action_groups ADD COLUMN stop_on_restore INTEGER DEFAULT 0;
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
