# Backlog

Known gaps deliberately left for later. Each entry: **what**, **why deferred**, **what unblocks it**, **where**.

## Tests for the ssh/winrm restore sequence and auto-restore

**What.** No automated coverage for any of the restore redesign:

- `parseRestoreSequence()` validation — MAC normalisation and rejection, `restore_action`
  gating of the command/URL requirements, restore auth-scheme rules, the wait clamp.
  Belongs with the other config cases in `tests/action-config.test.js`.
- `sendMagicPacket()` — packet shape (6 x `0xFF` then the MAC 16 times, 102 bytes); that a
  blank or `255.255.255.255` broadcast fans out one packet per non-internal IPv4 interface,
  sourced from that interface; and that an explicit address sends exactly one, routed
  normally. Testable with a `dgram` socket on port 9 reading `rinfo.address`.
- `restoreSequence()` — the wake -> wait -> final step order, that a host which never answers
  fails with the elapsed budget in the message, and that the HTTP final step authenticates
  from `restore_token` / `restore_password` rather than the host login.
- `runAutoRestore()` — the reverse walk (action groups, stages, then steps back to front),
  that only targets with `auto_restore` set take part, that a target reused across stages
  restores once, and that the `inFlight` guard stops a flapping group starting a second pass.
- Migration 7 — a legacy target with a bare `restore_command` comes out as
  `restore_action: 'command'` with auto-restore off.
- **Relays** — `parseRelayNetwork()` CIDR validation and normalisation to the network address;
  `parseWakeCommand()` requiring `{mac}`; `wakeViaRelay()` substituting the MAC and dispatching
  over the relay's own connection; `resolveWakeRelay()` returning null for a deleted or disabled
  relay so `restoreSequence()` reports it instead of silently skipping the wake; and relays
  surviving config export/import with `secret_enc` intact and key rotation re-encrypting them.
- **Relay reach warning** — `hostInNetwork()` in `public/scripts/actions.js`: inside, outside,
  and the null case for a hostname that is not an IP literal. Pure function, easy to cover once
  there is a place for browser-side unit tests (`tests/dom.test.js` is the nearest precedent).

**Why deferred.** The UI is still being iterated on, and the config schema these tests would
pin down moves with it. Writing them now would mean rewriting them next pass.

**What unblocks it.** Sign-off that the Restore panel on the Actions page is final.

**Where.** `server/connectors.js` (restore sequence section), `server/autoRestore.js`,
`server/index.js` (`parseRestoreSequence`, `parseRelayNetwork`, `parseWakeCommand`, the
`/api/relays` routes), `server/migrations.js` (versions 7 and 8), `public/actions.html` +
`public/scripts/actions.js` (the restore panel), `public/config.html` +
`public/scripts/config.js` (the Relays tab). Existing suites to extend:
`tests/action-config.test.js`, `tests/action-runs.test.js`, `tests/outage-lifecycle.test.js`,
`tests/config-transfer.test.js`.

## Manual restore reports only that it started

**What.** `POST /api/actions/targets/:id/restore` answers `202 { started: true }` for ssh/winrm
and leaves the sequence running, because waiting for a host to boot can take minutes. The
browser learns the outcome only from the target's "Last activity" on the next 20s poll — there
is no live progress for the wake / wait / final step, and nothing to cancel a wait in flight.

**Why deferred.** Wiring restore into the action-run machinery (a run row, live steps, the
pause/cancel controls) is a much larger change than the restore redesign itself, and the
polled result is enough to tell whether a target came back.

**What unblocks it.** A decision on whether a restore should be a first-class "run" the
dashboard tracks like an action group run.

**Where.** `server/index.js` (the restore route), `public/scripts/actions.js`
(`renderTargetTable`'s Restore button), `server/actionRuns.js` for the run model to mirror.
