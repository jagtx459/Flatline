# Restoration

Every action target can carry a **Restore** procedure: what Flatline does to
bring that target back after its trigger action ran. It is configured in the
collapsible *Restore* panel at the bottom of each target type's section on the Actions
page, and stored in the same config blob as the rest of the target.

There is **no snapshot of prior state anywhere**. A restore is only as good as
what the target's owner configured, Flatline does not record which nodes were
cordoned, which services were stopped, or what a shutdown command turned off.

## When a restore runs

Two entry points, both running the same sequence:

| | Trigger | Reaches |
| --- | --- | --- |
| **Auto-restore** | The Flatline group that triggered the actions recovers | Targets with **Auto-restore** ticked |
| **Restore button** | Clicked on a target's row (`POST /api/actions/targets/:id/restore`) | That one target, whether or not auto-restore is ticked |

The shutdown watcher evaluates groups every 5s ([shutdown.js:17](../server/shutdown.js#L17)).
When a group stops meeting its failure condition it disarms and if it had
already **triggered** its actions, it hands off to `runAutoRestore()`
([shutdown.js:92](../server/shutdown.js#L92)). A group that recovers inside its
grace period never triggered anything, so nothing is restored. The call is
deliberately not awaited: a restore waits minutes for hosts to boot, and the
watcher has every other group to keep evaluating.

A target takes part in auto-restore only when all of these hold
([autoRestore.js:60](../server/autoRestore.js#L60)):

- its type is `ssh`, `winrm`, `k8s` or `http` (all four, currently),
- the target is **enabled**,
- `auto_restore` is ticked on the target,
- it is a step in an **enabled** action group assigned to the recovered Flatline group.

The manual Restore button ignores `auto_restore` entirely. It is disabled in the
UI when the target has nothing configured to do
(`hasRestore()`, [actions.js:653](../public/scripts/actions.js#L653)), and the
server refuses a second concurrent restore of the same target with a 409.

## Auto-restore order

Targets come back in the **reverse of the order they went down in**
([autoRestore.js:83](../server/autoRestore.js#L83)):

1. the group's action groups, back to front,
2. each action group's stages, back to front,
3. the steps within a stage, back to front.

Steps in the same stage are restored **together** (`Promise.all`), one batch at
a time. Wait steps have nothing to undo and are skipped. A target used in more
than one step, stage or action group is restored **once**, at the first point the
reverse walk reaches it.

Ordering only decides who is *asked* first. What actually holds a machine behind
the one it depends on is each target's own wait for the host, the cluster's API
server, or the login endpoint to answer before the final step runs.

One auto-restore per Flatline group runs at a time: a group that flaps while its
restore is still going is logged and ignored (`inFlight`,
[autoRestore.js:28](../server/autoRestore.js#L28)).

## Common settings

**Auto-restore when the Flatline group recovers** — the tick box described above.

**Wait up to N seconds** (`restore_wait_seconds`) — 0 to 3600, default **300**.
This is a *give-up budget*, not a sleep: Flatline polls every 10s and moves on
the moment the target answers. `0` means one attempt, then give up. The probe is
the target's own connectivity test. It is the same **Test connection** button
and the background health poller run.

Everything after the wait runs with a **60s** timeout
(`DEFAULT_TIMEOUT_MS`, [connectors.js:31](../server/connectors.js#L31)); SSH
connection setup inside that is capped at 16s.

## SSH and WinRM Restore

Three parts, each optional except the wait that joins them
([connectors.js:700](../server/connectors.js#L700)):

### 1. Wake (optional)

Configured with a **Wake-on-LAN MAC** (`wol_mac`, stored canonically as
`AA:BB:CC:DD:EE:FF`). Leave it blank if the host comes back on its own, the
sequence then starts at the wait. The packet is the standard magic packet
(6 × `0xFF` then the MAC repeated 16 times) sent to UDP port 9.

Two ways to deliver it (`wake_mode`):

- **`packet` — from Flatline itself.** With no **Broadcast address**
  (`wol_broadcast`) set, Flatline sends one packet per non-internal IPv4
  interface, to that interface's own directed broadcast, *from* that interface
  ([connectors.js:583](../server/connectors.js#L583)). This removes the guess on
  a host with Hyper-V/WSL/Docker adapters. With an address set, exactly one
  packet goes there under normal routing. Broadcasts do not typically cross VLANs/interfaces, so
  this only reaches networks Flatline is attached to; in Docker that needs
  `network_mode: host`.
- **`relay` — through a machine on the target's network.** Flatline signs in to
  an SSH or WinRM **relay** (Config → WoL Relays) and runs the relay's own
  `wake_command` with every `{mac}` replaced by this target's MAC. A MAC is
  **required** once a relay is picked, and the relay must exist. A relay that was
  deleted or disabled after the target was configured fails the restore with a
  message saying so, rather than silently skipping the wake.

Relays carry their own connection config and credentials (same fields as an
ssh/winrm target, minus the restore panel), a CIDR **network** used only to warn
you in the UI when a relay cannot reach a target's address, and the wake command
itself. Defaults: `wakeonlan {mac}` for SSH relays, an inline PowerShell UDP
broadcast for WinRM relays (nothing to install on Windows).

A wake that fails stops the sequence there. Nothing ever answers a magic packet,
so success only means the packet was accepted for delivery. The destinations it
went to are reported in the result message.

### 2. Wait for the host

Polls the target's own test (SSH connect + `echo flatline-ok`, or WinRM
`Write-Output flatline-ok`) every 10s until it answers or the budget runs out.
Each attempt has an 8s timeout. If the host never answers, the restore fails and
the final step **is not run**.

### 3. Once it answers (`restore_action`)

| Value | What happens |
| --- | --- |
| `none` | Nothing. Being back up is the whole restore. |
| `command` | `restore_command` runs over the **same connection and credentials** as the trigger command, including the stored sudo password, which is written to the command's stdin (so the command needs `sudo -S`). A non-zero exit fails the restore. |
| `http` | Flatline sends `restore_method` (default POST) to `restore_url`, with `restore_body` as `application/json` if set. Sent **from Flatline**, not from the host. |

The HTTP option authenticates **separately** from the host login. The service
being resumed need not be the machine that was shut down
([connectors.js:671](../server/connectors.js#L671)). Its schemes are
`none` / `bearer` / `header` / `basic`, with their own secrets
(`restore_token`, `restore_password`) and `restore_header_name` /
`restore_username`. The SSH or WinRM password is never what this step sends.

A target with no MAC and `restore_action: none` has nothing to do, and reports
"no restore configured for this target".

## Kubernetes Cluster Restore

The connection is resolved **before** the wait, so a missing token or an
unparseable kubeconfig fails immediately instead of being buried under a
five-minute timeout ([connectors.js:904](../server/connectors.js#L904)). Then, in
this order:

1. **Wait for the API server** — polls `GET version` every 10s within the budget.
   Auto-restore starts the moment the Flatline group reports healthy, which is
   normally before the control plane has finished coming up.
2. **Uncordon every node** — `PATCH spec.unschedulable=false` on each. Always
   done for a `drain` target (it is the mirror image of its trigger); for a
   `custom` target it is the optional `restore_uncordon` tick box, on by default.
   Nothing records which nodes were cordoned before the outage, so **every** node
   in the cluster is uncordoned.
3. **Optional restore request** — one raw API call, `restore_method` (default
   `PATCH`, sent as `application/merge-patch+json`) to `restore_path` with
   `restore_body`. Offered whatever the trigger action was: a drained cluster can
   need a request of its own on the way back. Leave the path blank to skip it.
4. **Optional Deployment restart** (`restore_restart_deployments`) — the
   equivalent of `kubectl rollout restart deployment` in every namespace except
   `kube-system`, by stamping a fresh `kubectl.kubernetes.io/restartedAt`
   annotation. Evicted pods reschedule on their own once nodes are schedulable;
   this is for the ones that come back wedged.

Each part stops the ones behind it. There is no point scaling back up onto
nodes that would not take the pods. With none of steps 2–4 configured (only
possible on a `custom` target), the restore reports "no restore configured".

## HTTP(S) Restore

`restore_url` is the whole feature: with it blank there is nothing to undo and
the Restore button is disabled. The request reuses the target's **URL host,
credentials, TLS policy** (`insecure_tls` / `ca_cert`) and redirect handling;
only method, path and body differ ([connectors.js:516](../server/connectors.js#L516)).

How it starts depends on the auth scheme:

- **Static schemes** (`none`, `bearer`, `header`, `basic`) — sent **once,
  immediately**. There is no request that is safe to repeat while waiting: the
  restore request need not be idempotent, and the trigger request is the very
  thing being undone. `restore_wait_seconds` is ignored here.
- **`login` (2-Step auth)** — Flatline retries the **login** every 10s until it
  succeeds or the budget runs out, then sends the restore request with the token
  and cookies from that login. The login is performed fresh every time, never
  cached: a token minted during the outage would have expired by the time the
  service is back.

Redirects are followed (up to 5), and credentials are dropped when a redirect
crosses to another origin.

## Reporting and progress

A restore that opens with a wait runs for minutes with nothing to show, so those
are started and left running rather than held open:

- `POST …/restore` answers **202** (`started: true`) for `ssh`, `winrm` and `k8s`,
  and for `http` only when it uses `login` with a wait above 0
  (`isSequenceRestore()`, [targetConfig.js:54](../server/targetConfig.js#L54)).
  Everything else answers **200** with the finished result.
- While one runs, `GET …/restore` reports `{ running, progress, last_activity }`;
  the Actions page polls it every 3s and shows the current phase (e.g. *waiting
  up to 300s for SSH to answer*) with elapsed time in the target's row.
- Progress is in-memory only. A restart forgets it, an interrupted restore is
  not resumable.

Both auto and manual restores record the outcome the same way a triggered action
step does:

- the target's **Last activity**, with trigger `restore`;
- an event, `action_step_ok` or `action_step_failed`, which notification channels
  subscribe to as **Action step OK** / **Action step FAILED**. The message reads
  `Auto-restore after "<group>" recovered -> <target> (<type>): …` or
  `Manual restore: <target> (<type>): …`.

The message accumulates one clause per part of the sequence, so a failure says
how far it got. For example, `sent Wake-on-LAN for AA:…:FF via 10.1.20.255; SSH did not
answer within 300s (…)`.

## Limits worth knowing

- **No stored prior state.** Uncordon touches every node; the Deployment restart
  touches every Deployment outside `kube-system`; an SSH/WinRM restore runs
  exactly the command you configured.
- **One attempt per recovery.** A failed auto-restore is recorded and not
  retried; run it again with the Restore button.
- **The per-target guard covers the manual route only.** `isRestoring()` stops
  the button and the API from starting a second pass, but auto-restore's
  in-flight guard is keyed by *Flatline group*. **NOTE** a target can be shared by two groups
  that both recover at once and might be restored twice concurrently.
- **Restore is not gated on the target's health dot**, or on the target being
  enabled, when started from the button. Waiting for an unreachable target is
  what the sequence is for.
- **Auto-restore ignores targets in disabled action groups**, even if those
  targets ran before the group was disabled.
