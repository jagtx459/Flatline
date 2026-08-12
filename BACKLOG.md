# Backlog

Known gaps deliberately left for later. Each entry: **what**, **why deferred**, **what unblocks it**, **where**.

## Tests for the restore sequences and auto-restore

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
- **k8s drain and restore** — `restoreK8s()`'s order (fail fast on an unusable kubeconfig, then
  wait for the API server, then uncordon, then a custom target's own restore request, then the
  optional rollout restart), that a failing step stops the ones behind it, that a drain target
  always uncordons while a custom one only does when `restore_uncordon` is set, and that
  `restartAllDeployments()` patches
  `kubectl.kubernetes.io/restartedAt` on every Deployment outside `kube-system` and on none
  inside it. On the way down: `waitUntilDrained()` returning as soon as nothing evictable is
  left, re-issuing evictions each pass so a pod refused by a disruption budget still goes, and
  giving up at the step's deadline with the pods that are still running named in the message;
  and `snapshotSummary()` degrading to `?` counts rather than failing the drain. The one piece
  that needs no cluster, `isEvictable()`, is covered in `tests/k8s-drain.test.js`.

  Blocked on there being any k8s test double at all: `dev/mock-targets.js` is plain HTTP, and the
  connector speaks `node:https`. Three ways out, cheapest first:

  1. **A TLS stub** — extend `dev/mock-targets.js` with an HTTPS listener serving canned
     `api/v1/nodes`, `api/v1/pods` and `apis/apps/v1/*` responses, reached with a kubeconfig
     carrying `insecure-skip-tls-verify: true`. Needs a self-signed cert generated at test
     startup. Fast and hermetic, but it only ever returns what the fixture says, so it cannot
     catch a wrong assumption about how a real cluster behaves.
  2. **Make `k8sRequest` injectable** — pass it in, so the sequences can be driven with a plain
     function. Cheapest of all and no certs, but tests then prove the ordering logic only.
  3. **A real throwaway cluster via Docker** — where the machine has Docker Desktop running,
     stand up a single-node k3d or kind cluster in `before()`, point a target at its kubeconfig,
     and tear it down after. This is the only option that exercises the behaviour the drain
     actually depends on: eviction semantics, a PodDisruptionBudget refusing an eviction with a
     429 until it is satisfied, DaemonSet pods being recreated the moment they are evicted,
     static control-plane pods that never go, and `restartedAt` genuinely rolling a Deployment.
     Worth having for exactly the cases a fixture cannot fake. Costs a minute or two per run and
     depends on the developer's machine, so it belongs behind its own script (e.g.
     `npm run tests:k8s`) that skips with a clear message when Docker is not reachable — never
     part of the default `npm run tests`, and gated the same way in CI.
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

**What unblocks it.** Sign-off that the Restore panel on the Actions page is final. The k8s
cases additionally need a decision on which of the three test doubles above to build.

**Where.** `server/connectors.js` (restore sequence section, and the Kubernetes section's
`cordonAndDrainAllNodes` / `waitUntilDrained` / `restoreK8s` / `restartAllDeployments`),
`server/autoRestore.js`,
`server/index.js` (`parseRestoreSequence`, the k8s branch of `parseInfraConfig`,
`parseRelayNetwork`, `parseWakeCommand`, the
`/api/relays` routes), `server/migrations.js` (versions 7 and 8), `public/actions.html` +
`public/scripts/actions.js` (the restore panel), `public/config.html` +
`public/scripts/config.js` (the Relays tab), `dev/mock-targets.js` (where a TLS stub would go).
Existing suites to extend:
`tests/action-config.test.js`, `tests/action-runs.test.js`, `tests/outage-lifecycle.test.js`,
`tests/config-transfer.test.js`.

## Manual restore reports only that it started

**What.** `POST /api/actions/targets/:id/restore` answers `202 { started: true }` for ssh/winrm
and k8s and leaves the sequence running, because waiting for a host to boot — or for a cluster's
API server to answer — can take minutes. The browser learns the outcome only from the target's
"Last activity" on the next 20s poll — there is no live progress for the wake / wait / final
step, and nothing to cancel a wait in flight.

**Why deferred.** Wiring restore into the action-run machinery (a run row, live steps, the
pause/cancel controls) is a much larger change than the restore redesign itself, and the
polled result is enough to tell whether a target came back.

**What unblocks it.** A decision on whether a restore should be a first-class "run" the
dashboard tracks like an action group run.

**Where.** `server/index.js` (the restore route), `public/scripts/actions.js`
(`renderTargetTable`'s Restore button), `server/actionRuns.js` for the run model to mirror.
