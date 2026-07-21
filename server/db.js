import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, migrations } from './migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.FLATLINE_DATA_DIR ?? path.join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const dbFile = path.join(dataDir, 'flatline.db');
const LATEST_VERSION = Math.max(...migrations.map((m) => m.version));

// Per-connection pragmas (not schema — these don't belong in migrations).
function openDb() {
  const conn = new DatabaseSync(dbFile);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA foreign_keys = ON');
  return conn;
}

// `db` is a mutable binding because restoring a backup swaps the underlying
// file and reopens the connection (see applyRestore). Every function here
// references this module-scoped variable, and other modules reach the database
// only through the store.* functions — nothing imports `db` directly — so the
// reopen is transparent to the rest of the app.
export let db = openDb();

migrate(db);

const DEFAULT_SETTINGS = {
  grace_minutes: '5',
  retention_days: '14'
};
{
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
}

// ---- endpoints ----

export function listEndpoints() {
  const endpoints = db.prepare('SELECT * FROM endpoints ORDER BY id').all();
  attachEndpointGroups(endpoints);
  return endpoints;
}

export function getEndpoint(id) {
  const ep = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(id);
  if (ep) attachEndpointGroups([ep]);
  return ep;
}

/** An endpoint can belong to any number of Flatline groups (many-to-many). */
function attachEndpointGroups(endpoints) {
  const memberships = db.prepare(`
    SELECT m.endpoint_id, m.flatline_group_id, g.name AS group_name
    FROM flatline_group_endpoints m JOIN flatline_groups g ON g.id = m.flatline_group_id
  `).all();
  for (const ep of endpoints) {
    const mine = memberships.filter((m) => m.endpoint_id === ep.id);
    ep.group_ids = mine.map((m) => m.flatline_group_id);
    ep.group_names = mine.map((m) => m.group_name);
  }
}

// Group membership is owned by the Flatline-group form, so endpoint
// create/update never touches it: new endpoints start ungrouped and edits
// preserve current group memberships.

export function createEndpoint(e) {
  const r = db.prepare(`
    INSERT INTO endpoints
      (name, type, target, interval_seconds, timeout_ms, down_threshold,
       up_threshold, expect_status, expect_json, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    e.name, e.type, e.target, e.interval_seconds, e.timeout_ms,
    e.down_threshold, e.up_threshold, e.expect_status, e.expect_json,
    e.enabled, Date.now()
  );
  return getEndpoint(Number(r.lastInsertRowid));
}

export function updateEndpoint(id, e) {
  db.prepare(`
    UPDATE endpoints SET
      name = ?, type = ?, target = ?, interval_seconds = ?, timeout_ms = ?,
      down_threshold = ?, up_threshold = ?, expect_status = ?, expect_json = ?,
      enabled = ?
    WHERE id = ?
  `).run(
    e.name, e.type, e.target, e.interval_seconds, e.timeout_ms,
    e.down_threshold, e.up_threshold, e.expect_status, e.expect_json,
    e.enabled, id
  );
  return getEndpoint(id);
}

export function deleteEndpoint(id) {
  db.prepare('DELETE FROM endpoints WHERE id = ?').run(id);
}

export function setEndpointState(id, state, ts) {
  db.prepare('UPDATE endpoints SET last_state = ?, last_change_ts = ? WHERE id = ?')
    .run(state, ts, id);
}

// ---- checks ----

export function recordCheck(endpointId, c) {
  db.prepare(`
    INSERT INTO checks (endpoint_id, ts, ok, latency_ms, status_code, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(endpointId, c.ts, c.ok ? 1 : 0, c.latencyMs ?? null,
         c.statusCode ?? null, c.error ?? null);
}

export function recentChecks(endpointId, limit) {
  const rows = db.prepare(`
    SELECT ts, ok, latency_ms, status_code, error
    FROM checks WHERE endpoint_id = ?
    ORDER BY ts DESC LIMIT ?
  `).all(endpointId, limit);
  return rows.reverse();
}

/**
 * History grouped into fixed time slices so the dashboard draws any range at a
 * constant point count. total/ok_count let the client compute exact uptime.
 */
export function bucketedHistory(endpointId, fromTs, toTs, bucketCount) {
  const bucketMs = Math.max(1000, Math.floor((toTs - fromTs) / bucketCount));
  const buckets = db.prepare(`
    SELECT
      CAST((ts - ?) / ? AS INTEGER)             AS bucket,
      COUNT(*)                                  AS total,
      SUM(ok)                                   AS ok_count,
      AVG(CASE WHEN ok = 1 THEN latency_ms END) AS avg_latency,
      MAX(CASE WHEN ok = 1 THEN latency_ms END) AS max_latency
    FROM checks
    WHERE endpoint_id = ? AND ts >= ? AND ts < ?
    GROUP BY bucket ORDER BY bucket
  `).all(fromTs, bucketMs, endpointId, fromTs, toTs);
  return { bucketMs, fromTs, buckets };
}

export function uptimeStats(endpointId, fromTs) {
  return db.prepare(`
    SELECT COUNT(*) AS total, SUM(ok) AS ok_count
    FROM checks WHERE endpoint_id = ? AND ts >= ?
  `).get(endpointId, fromTs);
}

export function pruneHistory(olderThanTs) {
  db.prepare('DELETE FROM checks WHERE ts < ?').run(olderThanTs);
  db.prepare('DELETE FROM events WHERE ts < ?').run(olderThanTs);
}

// ---- events ----

// Every recorded event also flows to the notifier (see notify.js), which
// registers itself here to avoid a circular import. Fire-and-forget: a
// notification failure must never break the write path.
let eventHook = null;
export function onEvent(hook) {
  eventHook = hook;
}

export function recordEvent(ev) {
  db.prepare(`
    INSERT INTO events (ts, endpoint_id, kind, from_state, to_state, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ev.ts, ev.endpointId ?? null, ev.kind, ev.fromState ?? null,
         ev.toState ?? null, ev.message ?? null);
  if (eventHook) queueMicrotask(() => eventHook(ev));
}

export function listEvents(limit) {
  return db.prepare(`
    SELECT e.*, p.name AS endpoint_name
    FROM events e LEFT JOIN endpoints p ON p.id = e.endpoint_id
    ORDER BY e.ts DESC LIMIT ?
  `).all(limit);
}

// ---- flatline groups ----

export function listFlatlineGroups() {
  const groups = db.prepare('SELECT * FROM flatline_groups ORDER BY id').all();
  const actions = db.prepare('SELECT flatline_group_id, action_group_id FROM flatline_group_actions').all();
  const members = db.prepare('SELECT flatline_group_id, endpoint_id FROM flatline_group_endpoints').all();
  for (const g of groups) {
    g.action_group_ids = actions
      .filter((a) => a.flatline_group_id === g.id)
      .map((a) => a.action_group_id);
    g.endpoint_ids = members
      .filter((m) => m.flatline_group_id === g.id)
      .map((m) => m.endpoint_id);
    g.endpoint_count = g.endpoint_ids.length;
  }
  return groups;
}

export function getFlatlineGroup(id) {
  return listFlatlineGroups().find((g) => g.id === id);
}

export function createFlatlineGroup(g) {
  const r = db.prepare(`
    INSERT INTO flatline_groups (name, grace_minutes, mode, enabled, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(g.name, g.grace_minutes, g.mode, g.enabled, Date.now());
  const id = Number(r.lastInsertRowid);
  setFlatlineGroupActions(id, g.action_group_ids);
  setFlatlineGroupEndpoints(id, g.endpoint_ids);
  return getFlatlineGroup(id);
}

export function updateFlatlineGroup(id, g) {
  db.prepare(`
    UPDATE flatline_groups SET name = ?, grace_minutes = ?, mode = ?, enabled = ?
    WHERE id = ?
  `).run(g.name, g.grace_minutes, g.mode, g.enabled, id);
  setFlatlineGroupActions(id, g.action_group_ids);
  setFlatlineGroupEndpoints(id, g.endpoint_ids);
  return getFlatlineGroup(id);
}

/**
 * Membership is owned by the group: replaces this group's endpoint set with
 * exactly the listed endpoints. An endpoint can belong to any number of
 * groups at once, so other groups' memberships are untouched.
 */
function setFlatlineGroupEndpoints(groupId, endpointIds) {
  db.prepare('DELETE FROM flatline_group_endpoints WHERE flatline_group_id = ?').run(groupId);
  const ins = db.prepare('INSERT OR IGNORE INTO flatline_group_endpoints (flatline_group_id, endpoint_id) VALUES (?, ?)');
  for (const epId of endpointIds ?? []) ins.run(groupId, epId);
}

export function deleteFlatlineGroup(id) {
  db.prepare('DELETE FROM flatline_groups WHERE id = ?').run(id);
}

function setFlatlineGroupActions(groupId, actionGroupIds) {
  db.prepare('DELETE FROM flatline_group_actions WHERE flatline_group_id = ?').run(groupId);
  const ins = db.prepare('INSERT OR IGNORE INTO flatline_group_actions (flatline_group_id, action_group_id) VALUES (?, ?)');
  for (const agId of actionGroupIds ?? []) ins.run(groupId, agId);
}

// ---- action targets ----
// secret_enc is an opaque encrypted blob (see secrets.js); this layer never
// decrypts it and list/get results must be shaped by the API layer before
// leaving the process.

export function listActionTargets() {
  return db.prepare('SELECT * FROM action_targets ORDER BY id').all();
}

export function getActionTarget(id) {
  return db.prepare('SELECT * FROM action_targets WHERE id = ?').get(id);
}

export function createActionTarget(t) {
  const r = db.prepare(`
    INSERT INTO action_targets (name, kind, config, secret_enc, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(t.name, t.kind, t.config, t.secret_enc, t.enabled, Date.now());
  return getActionTarget(Number(r.lastInsertRowid));
}

export function updateActionTarget(id, t) {
  db.prepare(`
    UPDATE action_targets SET name = ?, kind = ?, config = ?, secret_enc = ?, enabled = ?
    WHERE id = ?
  `).run(t.name, t.kind, t.config, t.secret_enc, t.enabled, id);
  return getActionTarget(id);
}

export function deleteActionTarget(id) {
  db.prepare('DELETE FROM action_targets WHERE id = ?').run(id);
}

// ---- action groups ----

export function listActionGroups() {
  const groups = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM flatline_group_actions a WHERE a.action_group_id = g.id) AS assigned_count
    FROM action_groups g ORDER BY g.id
  `).all();
  const members = db.prepare(`
    SELECT action_group_id, target_id, stage, timeout_seconds
    FROM action_group_members ORDER BY stage, position
  `).all();
  const stages = db.prepare(`
    SELECT action_group_id, stage, pass_rule, on_failure
    FROM action_group_stages ORDER BY stage
  `).all();
  for (const g of groups) {
    g.stages = stages
      .filter((s) => s.action_group_id === g.id)
      .map((s) => ({
        pass_rule: s.pass_rule,
        on_failure: s.on_failure, // null = inherit the group's on_failure
        steps: members
          .filter((m) => m.action_group_id === g.id && m.stage === s.stage)
          .map((m) => ({ target_id: m.target_id, timeout_seconds: m.timeout_seconds }))
      }));
  }
  return groups;
}

export function getActionGroup(id) {
  return listActionGroups().find((g) => g.id === id);
}

export function createActionGroup(g) {
  const r = db.prepare('INSERT INTO action_groups (name, on_failure, enabled, created_at) VALUES (?, ?, ?, ?)')
    .run(g.name, g.on_failure, g.enabled, Date.now());
  const id = Number(r.lastInsertRowid);
  setActionGroupStages(id, g.stages);
  return getActionGroup(id);
}

export function updateActionGroup(id, g) {
  db.prepare('UPDATE action_groups SET name = ?, on_failure = ?, enabled = ? WHERE id = ?')
    .run(g.name, g.on_failure, g.enabled, id);
  setActionGroupStages(id, g.stages);
  return getActionGroup(id);
}

export function deleteActionGroup(id) {
  db.prepare('DELETE FROM action_groups WHERE id = ?').run(id);
}

/**
 * Stages run in array order; the steps within a stage run simultaneously.
 * `stage` records the sequence across stages, `position` the order within one.
 */
function setActionGroupStages(groupId, stages) {
  db.prepare('DELETE FROM action_group_stages WHERE action_group_id = ?').run(groupId);
  db.prepare('DELETE FROM action_group_members WHERE action_group_id = ?').run(groupId);
  const insStage = db.prepare(`
    INSERT INTO action_group_stages (action_group_id, stage, pass_rule, on_failure)
    VALUES (?, ?, ?, ?)
  `);
  const insMember = db.prepare(`
    INSERT INTO action_group_members (action_group_id, target_id, stage, position, timeout_seconds)
    VALUES (?, ?, ?, ?, ?)
  `);
  (stages ?? []).forEach((st, si) => {
    insStage.run(groupId, si, st.pass_rule, st.on_failure ?? null);
    (st.steps ?? []).forEach((s, pi) => insMember.run(groupId, s.target_id, si, pi, s.timeout_seconds));
  });
}

// ---- notification channels ----
// Same shape as action targets: config is plaintext JSON, secret_enc is the
// encrypted blob from secrets.js and must be masked by the API layer.

export function listNotificationChannels() {
  return db.prepare('SELECT * FROM notification_channels ORDER BY id').all();
}

export function getNotificationChannel(id) {
  return db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
}

export function createNotificationChannel(c) {
  const r = db.prepare(`
    INSERT INTO notification_channels (name, kind, config, secret_enc, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(c.name, c.kind, c.config, c.secret_enc, c.enabled, Date.now());
  return getNotificationChannel(Number(r.lastInsertRowid));
}

export function updateNotificationChannel(id, c) {
  db.prepare(`
    UPDATE notification_channels SET name = ?, kind = ?, config = ?, secret_enc = ?, enabled = ?
    WHERE id = ?
  `).run(c.name, c.kind, c.config, c.secret_enc, c.enabled, id);
  return getNotificationChannel(id);
}

export function deleteNotificationChannel(id) {
  db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
}

// ---- encryption-key rotation support ----
// Every row in every table that stores an encrypted blob. Key rotation
// decrypts all of these with the old key and rewrites them with the new one
// in a single transaction (see the /api/config/key handlers in index.js).

const ENCRYPTED_TABLES = ['action_targets', 'notification_channels'];

export function allEncryptedRows() {
  const rows = [];
  for (const table of ENCRYPTED_TABLES) {
    for (const r of db.prepare(`SELECT id, secret_enc FROM ${table} WHERE secret_enc IS NOT NULL`).all()) {
      rows.push({ table, id: r.id, secret_enc: r.secret_enc });
    }
  }
  return rows;
}

/** Rewrites re-encrypted blobs atomically. rows: [{ table, id, secret_enc }] */
export function updateEncryptedRows(rows) {
  const stmts = Object.fromEntries(ENCRYPTED_TABLES.map((t) =>
    [t, db.prepare(`UPDATE ${t} SET secret_enc = ? WHERE id = ?`)]));
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!stmts[r.table]) throw new Error(`unknown table '${r.table}'`);
      stmts[r.table].run(r.secret_enc, r.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- settings ----

export function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    out[row.key] = row.value;
  }
  return out;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// ---- config export / import ----
// The portable configuration: everything a fresh instance needs to reproduce
// this one's monitoring and actions, minus history (checks/events) and site
// security (the password hash never leaves). Encrypted blobs (secret_enc) are
// copied verbatim, so they only decrypt on an instance holding the same key.
//
// Columns are listed per table (never SELECT *) so runtime-only fields —
// endpoints.last_state/last_change_ts — are left at their defaults on import.
// Import preserves ids, which keeps the join tables valid without remapping.
const CONFIG_TABLES = {
  endpoints: ['id', 'name', 'type', 'target', 'interval_seconds', 'timeout_ms',
              'down_threshold', 'up_threshold', 'expect_status', 'expect_json', 'enabled', 'created_at'],
  action_targets: ['id', 'name', 'kind', 'config', 'secret_enc', 'enabled', 'created_at'],
  action_groups: ['id', 'name', 'on_failure', 'enabled', 'created_at'],
  action_group_stages: ['action_group_id', 'stage', 'pass_rule', 'on_failure'],
  action_group_members: ['action_group_id', 'target_id', 'position', 'timeout_seconds', 'stage'],
  flatline_groups: ['id', 'name', 'grace_minutes', 'mode', 'enabled', 'created_at'],
  flatline_group_endpoints: ['flatline_group_id', 'endpoint_id'],
  flatline_group_actions: ['flatline_group_id', 'action_group_id'],
  notification_channels: ['id', 'name', 'kind', 'config', 'secret_enc', 'enabled', 'created_at']
};

// Parents before children, so foreign keys resolve as rows go in.
const INSERT_ORDER = [
  'endpoints', 'action_targets', 'action_groups', 'action_group_stages', 'action_group_members',
  'flatline_groups', 'flatline_group_endpoints', 'flatline_group_actions', 'notification_channels'
];

// Only these settings are portable; auth_password_hash is deliberately excluded.
const PORTABLE_SETTINGS = ['retention_days', 'allowed_hosts'];

export function exportConfig() {
  const out = {};
  for (const [table, cols] of Object.entries(CONFIG_TABLES)) {
    out[table] = db.prepare(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY rowid`).all();
  }
  const s = getSettings();
  out.settings = Object.fromEntries(PORTABLE_SETTINGS.filter((k) => k in s).map((k) => [k, s[k]]));
  return out;
}

/**
 * Replaces ALL configuration with the given payload (from exportConfig), in one
 * transaction. Validates shape before touching anything so a bad file can't
 * leave a half-wiped config; DB constraints (CHECK/FK/NOT NULL) catch the rest
 * and roll the whole thing back. Returns per-table insert counts.
 */
export function replaceConfig(data) {
  if (typeof data !== 'object' || data === null) throw new Error('not a config object');
  if (data.flatline_config !== 1) throw new Error('unrecognized config file (missing flatline_config marker)');

  const rows = {};
  for (const [table, cols] of Object.entries(CONFIG_TABLES)) {
    const arr = data[table] ?? [];
    if (!Array.isArray(arr)) throw new Error(`${table} must be an array`);
    for (const r of arr) {
      if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new Error(`${table} has a non-object row`);
    }
    rows[table] = arr;
  }

  const inserts = Object.fromEntries(INSERT_ORDER.map((t) => {
    const cols = CONFIG_TABLES[t];
    return [t, db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)];
  }));

  const counts = {};
  db.exec('BEGIN');
  try {
    // Children before parents; deleting endpoints cascades their checks/events.
    for (const t of [...INSERT_ORDER].reverse()) db.exec(`DELETE FROM ${t}`);
    for (const t of INSERT_ORDER) {
      const cols = CONFIG_TABLES[t];
      let n = 0;
      for (const r of rows[t]) {
        inserts[t].run(...cols.map((c) => r[c] ?? null));
        n += 1;
      }
      counts[t] = n;
    }
    const s = data.settings;
    if (s && typeof s === 'object') {
      for (const k of PORTABLE_SETTINGS) {
        if (s[k] != null) setSetting(k, s[k]);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return counts;
}

/**
 * Factory reset: wipes ALL configuration, history, and settings — including the
 * site password hash and allowed hosts — back to a fresh-install state, in one
 * transaction. The encryption key (a file, not a DB row) is deliberately left
 * in place. The caller must reschedule the poller and invalidate the security
 * cache afterwards, since auth is now off.
 */
export function resetAll() {
  db.exec('BEGIN');
  try {
    for (const t of [...INSERT_ORDER].reverse()) db.exec(`DELETE FROM ${t}`);
    db.exec('DELETE FROM checks');  // deleting endpoints cascades most of these,
    db.exec('DELETE FROM events');  // but clear both outright (incl. system events)
    db.exec('DELETE FROM settings');
    const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- full-database backup / restore ----

/** Folds the WAL into the main db file so a raw read of dbFile is a complete snapshot. */
export function checkpoint() {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

// The uploaded backup is streamed here (not buffered in memory), so restore is
// bounded by free space on the data volume — the same volume the live DB grows
// on — rather than an arbitrary size limit.
export const restoreTmpFile = dbFile + '.restore';

export function discardRestore() {
  rmSync(restoreTmpFile, { force: true });
}

/**
 * Swaps a streamed-in backup (already written to restoreTmpFile) into place and
 * reopens the connection — no process restart required. The file is validated
 * (real SQLite, Flatline schema, not from a newer build) BEFORE the live DB is
 * touched, so a bad upload leaves everything running. The swap then closes the
 * live handle (so the file can be replaced — required on Windows, harmless on
 * Linux), renames the backup over dbFile, drops the stale WAL/SHM, reopens, and
 * migrates in case the backup is from an older build. It's all synchronous, so
 * no queued timer can touch the DB mid-swap.
 */
export function applyRestore() {
  let probe = null;
  try {
    probe = new DatabaseSync(restoreTmpFile, { readOnly: true });
    const hasEndpoints = probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='endpoints'").get();
    if (!hasEndpoints) throw new Error('not a Flatline database (missing tables)');
    const { user_version: v } = probe.prepare('PRAGMA user_version').get();
    if (v > LATEST_VERSION) throw new Error(`backup is from a newer Flatline version (schema v${v} > v${LATEST_VERSION})`);
    probe.close();
    probe = null;
  } catch (err) {
    try { probe?.close(); } catch { /* already closed */ }
    rmSync(restoreTmpFile, { force: true });
    throw new Error(/not a Flatline|newer Flatline/.test(err.message) ? err.message : 'not a valid SQLite database');
  }

  db.close();
  renameSync(restoreTmpFile, dbFile);
  rmSync(dbFile + '-wal', { force: true });
  rmSync(dbFile + '-shm', { force: true });
  db = openDb();
  migrate(db); // upgrade an older backup to the current schema if needed
}
