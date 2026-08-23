# Restoration

Every action target can carry a **Restore**: what Flatline does to bring that
target back after its trigger action ran. It is configured in the collapsible
*Restore* panel at the bottom of the target form on the Actions page, and stored
in the same config blob as the rest of the target.

A restore is always the same three steps, whatever kind of target it belongs to:

```
1. the restore  ->  2. the wait  ->  3. a post-restore action (optional)
```

Step 1 is what actually brings the target back, and offers only the three things
that work on something that is *not* answering: **Wake-on-LAN**, **Kubernetes**,
or an **HTTP(S) endpoint**. Step 3 is anything else that needs doing once it is
up — including a shell command, which needs a machine already listening and so
can never be step 1.

Both steps' methods are chosen independently of how the target itself is reached
and of each other. A cluster taken down over its API can be woken with a magic
packet and finished off over SSH; a NAS shut down through its HTTP API can be
resumed through another endpoint and then have its shares remounted by a command
on a different host. Each step either **inherits** the target's own connection
and credentials, or brings its own.

There is **no snapshot of prior state anywhere**. A restore is only as good as
what the target's owner configured — Flatline does not record which nodes were
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
([autoRestore.js:56](../server/autoRestore.js#L56)):

- the target is **enabled**,
- **Enable restore** is on,
- **Auto-restore** is ticked,
- it is a step in an **enabled** action group assigned to the recovered Flatline group.

`auto_restore` lives inside the restore and is cleared with it, so "ticked but
nothing configured" is not a state a saved target can be in.

The manual Restore button ignores `auto_restore` entirely. It is disabled in the
UI when the target has no restore (`hasRestore()`,
[actions.js](../public/scripts/actions.js)), and the server refuses a second
concurrent restore of the same target with a 409.

## Auto-restore order

Targets come back in the **reverse of the order they went down in**
([autoRestore.js:79](../server/autoRestore.js#L79)):

1. the group's action groups, back to front,
2. each action group's stages, back to front,
3. the steps within a stage, back to front.

Steps in the same stage are restored **together** (`Promise.all`), one batch at
a time. Wait steps have nothing to undo and are skipped. A target used in more
than one step, stage or action group is restored **once**, at the first point the
reverse walk reaches it.

Ordering only decides who is *asked* first. What actually holds a machine behind
the one it depends on is each target's own wait.

One auto-restore per Flatline group runs at a time: a group that flaps while its
restore is still going is logged and ignored (`inFlight`,
[autoRestore.js:24](../server/autoRestore.js#L24)).

## The three steps

Every field of a step lives under that step's prefix — `restore_` for step 1,
`post_restore_` for step 3 — with the same bare name on both sides
(`restore_url` / `post_restore_url`, `restore_token` / `post_restore_token`, …).
That is what lets one set of parsers, runners and form wiring serve both.

### 1. The restore (`restore_kind`)

One of three, and required — a restore with no step 1 would have nothing to act
with.

| `restore_kind` | What happens |
| --- | --- |
| `wol` | A magic packet, then (with no step 3 behind it) a wait for the target itself. |
| `k8s` | Wait for the API server, then up to three parts: uncordon every node, one raw API request, restart every Deployment. |
| `http` | One request: `restore_method` (default POST) to `restore_url`, with `restore_body` as `application/json` if set. |

#### Wake-on-LAN

Configured with a **Wake MAC** (`wol_mac`, stored canonically as
`AA:BB:CC:DD:EE:FF`) and offered to **every kind of target** — what shut a
machine down says nothing about whether it needs a magic packet to come back.
The packet is the standard magic packet (6 × `0xFF` then the MAC repeated 16
times) sent to UDP port 9.

Leaving the MAC **blank** is how "the machine is already up, only do the
follow-up" is said: nothing is broadcast and the restore goes straight to step 3.
A restore with neither a MAC nor a step 3 is refused, since it would do nothing
at all.

Two ways to deliver it (`wake_mode`):

- **`packet` — from Flatline itself.** With no **Broadcast** address
  (`wol_broadcast`) set, Flatline sends one packet per non-internal IPv4
  interface, to that interface's own directed broadcast, *from* that interface
  ([connectors.js](../server/connectors.js)). This removes the guess on a host
  with Hyper-V/WSL/Docker adapters. With an address set, exactly one packet goes
  there under normal routing. Broadcasts do not typically cross VLANs, so this
  only reaches networks Flatline is attached to; in Docker that needs
  `network_mode: host`.
- **`relay` — through a machine on the target's network.** Flatline signs in to
  an SSH or WinRM **relay** (Config → WoL Relays) and runs the relay's own
  `wake_command` with every `{mac}` replaced by this target's MAC. A MAC is
  **required** once a relay is picked, and the relay must exist. A relay that was
  deleted or disabled after the target was configured fails the restore with a
  message saying so, rather than silently skipping the wake.

Relays carry their own connection config and credentials (same fields as an
ssh/winrm target, minus the restore panel), a CIDR **network** used only to warn
you in the UI when a relay cannot reach the address the restore will connect to,
and the wake command itself. Defaults: `wakeonlan {mac}` for SSH relays, an
inline PowerShell UDP broadcast for WinRM relays (nothing to install on Windows).

A wake that fails stops the sequence there. Nothing ever answers a magic packet,
so success only means the packet was accepted for delivery. The destinations it
went to are reported in the result message.

### 2. The wait

**Wait up to N seconds** (`restore_wait_seconds`) — 0 to 3600, default **300**.
This is a *give-up budget*, not a sleep: Flatline polls every 10s and moves on
the moment what it is waiting for answers. `0` means one attempt, then give up.

One budget, spent wherever the sequence actually has to wait, using that
connection's own connectivity test — the same one the **Test connection** button
and the background health poller run:

| Step | Polls |
| --- | --- |
| `wol`, with a step 3 behind it | Nothing — step 3 waits on the machine it is about to act on, which is the better probe |
| `wol`, alone | The **target's** own test, when it has one that is safe to repeat |
| `ssh` / `winrm` (step 3) | An SSH connect + `echo flatline-ok`, or WinRM `Write-Output flatline-ok` |
| `k8s` | `GET version` on the API server, **before** its uncordon/restart run |
| `http`, inheriting a target that logs in | The **login**, retried until it succeeds |
| `http`, otherwise | The **target's** own test, when the target has one that is safe to repeat |

Because a Kubernetes step has to reach the API server before it can do anything,
its share of the budget is spent *inside* step 1 rather than after it — the
numbering on the page reads 1-2-3 but a cluster restore waits first.

The HTTP method never polls its own request: it need not be idempotent, and the
trigger request is the very thing being undone. When it brings its own
connection it falls back to the target's test — the target is the machine the
wake was aimed at, which holds the "wake the host, wait for it, then call a
resume API" shape. An HTTP target using a static auth scheme has no safe probe at
all (its test *is* its real request), so there the request is sent once and the
budget is ignored.

If the wait runs out the restore fails there, and **nothing after it runs**.

Everything after a wait runs with a **60s** timeout
(`DEFAULT_TIMEOUT_MS`, [connectors.js:31](../server/connectors.js#L31)); SSH
connection setup inside that is capped at 16s.

### 3. The post-restore action (`post_restore_kind`)

Optional, and `none` by default. It runs only once step 1 has succeeded — a
failed step 1 stops the sequence there rather than acting on something that
never came back.

| `post_restore_kind` | What happens |
| --- | --- |
| `none` | Nothing. Step 1 was the whole restore. |
| `ssh` / `winrm` | Wait for the host, then run `post_restore_command`. When inheriting, that includes the stored sudo password, written to the command's stdin (so the command needs `sudo -S`). A non-zero exit fails the restore. |
| `k8s` | The same three parts a step-1 cluster restore has, against whatever cluster this step points at. |
| `http` | One request: `post_restore_method` (default POST) to `post_restore_url`. |

### Where each step connects

`restore_inherit` and `post_restore_inherit` each pick where their own step
connects, independently.

**Inheriting** reuses the target's own connection and credentials, and is only on
offer when that step's method matches the target's kind — an HTTP target has no
SSH login to lend an SSH action. Otherwise the step carries its own address and
its own encrypted credentials, under its prefixed names that mirror the method's
normal fields (`post_restore_host`, `post_restore_username`,
`post_restore_password`, …). The rename is all `restoreConnection()` does before
handing off, so nothing below that point knows which of the two it got — nor
which step it is running.

The two credential sets are genuinely separate: a step-1 HTTP endpoint's
`restore_token` and a step-3 cluster's `post_restore_token` are stored, resolved
and dropped independently.

An HTTP step that brings its own connection carries its own auth scheme
(`none` / `bearer` / `header` / `basic`), TLS policy (`…_insecure_tls` /
`…_ca_cert`) and secrets (`…_token`, `…_password`). The `login` scheme is not on
offer there: a login round trip belongs to a target, which has room for the whole
conversation it needs.

### The Kubernetes method in detail

The same in either step; the field names below take that step's prefix.

The connection is resolved **before** the wait, so a missing token or an
unparseable kubeconfig fails immediately instead of being buried under a
five-minute timeout. Then, in this order:

1. **Uncordon every node** (`…_uncordon`) — `PATCH spec.unschedulable=false`
   on each. This is an explicit choice, defaulted on in the form: it is the
   mirror image of a cordon + drain, but nothing infers it from the trigger
   action, because the cluster being restored need not be the one this target
   shut down. Nothing records which nodes were cordoned before the outage, so
   **every** node in the cluster is uncordoned.
2. **Optional restore request** — one raw API call, `…_method` (default
   `PATCH`, sent as `application/merge-patch+json`) to `…_path` with
   `…_body`. Leave the path blank to skip it.
3. **Optional Deployment restart** (`…_restart_deployments`) — the
   equivalent of `kubectl rollout restart deployment` in every namespace except
   `kube-system`, by stamping a fresh `kubectl.kubernetes.io/restartedAt`
   annotation. Evicted pods reschedule on their own once nodes are schedulable;
   this is for the ones that come back wedged.

Each part stops the ones behind it. There is no point scaling back up onto nodes
that would not take the pods. The form refuses to save a cluster restore with
none of the three selected.

## Reporting and progress

A restore that opens with a wait runs for minutes with nothing to show, so those
are started and left running rather than held open:

- `POST …/restore` answers **202** (`started: true`) whenever the restore has a
  wake or a wait to sit through (`isSequenceRestore()`,
  [targetConfig.js](../server/targetConfig.js)). Everything else answers **200**
  with the finished result.
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

## Upgrading

### From the type-locked restore (migration 9)

Before that, a restore was whatever shape the target's kind implied: only
ssh/winrm could wake a host, only a k8s target could uncordon, and an http target
could do nothing but replay one request. Migration 9 maps every existing restore
onto a chosen method without changing what it does:

| Was | Becomes |
| --- | --- |
| ssh/winrm with `restore_action: 'command'` | `restore_kind` = the target's kind, `restore_inherit: 1` |
| ssh/winrm with `restore_action: 'http'` | `restore_kind: 'http'`, `restore_inherit: 0` — that step always authenticated separately, and its fields already used `restore_` names |
| ssh/winrm with a MAC and no final step | `restore_kind: 'none'` |
| k8s | `restore_kind: 'k8s'`, `restore_inherit: 1`, with the uncordon that a `drain` target used to imply now written down |
| http with a `restore_url` | `restore_kind: 'http'`, `restore_inherit: 1` |

`restore_enabled` is set from whether the old config would actually have done
anything — the same test the Restore button used to enable itself with — so a
target that was never set up does not silently acquire a restore.

### From the single-action restore (migration 10)

That one action then split in two, so that the thing which brings a target back
and the thing that finishes the job could be picked separately. Migration 10
moves each existing restore into whichever step it belongs in:

| Was | Becomes |
| --- | --- |
| `restore_kind: 'ssh'` / `'winrm'` | `restore_kind: 'wol'` + `post_restore_kind` = that kind, with `restore_host`/`_port`/`_domain`/`_username`/`_auth_method`/`_command` moved to `post_restore_` names |
| the same, with no MAC | the same — a wake with a blank MAC, which broadcasts nothing and goes straight to step 3 |
| `restore_kind: 'none'` | `restore_kind: 'wol'`, `post_restore_kind: 'none'` |
| `restore_kind: 'k8s'` / `'http'` | unchanged; both are still step-1 methods |

A shell restore that carried its own credentials has them decrypted and rewritten
under `post_restore_` names in the same transaction, because that is where step 3
looks for them. A blob that will not decrypt (a lost key) is left exactly as it
is rather than discarded.

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
- **Changing either step's method drops that step's old credentials.** The
  allowed secret list narrows with both methods (`secretFieldsFor()`), so a
  credential neither step connects with any more is not left sitting encrypted in
  the blob.
