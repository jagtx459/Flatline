# Local testing

| Command | What it is |
| --- | --- |
| `npm run tests` | The checker. Asserts specific outcomes against the app and the run engine, and fails on error. Touches nothing in the `data` directory. Every run of `tests` uses its own throwaway database. |
| `npm run dev` | A live instance on demo data, everything healthy, for clicking around. |
| `npm run dev:tests` | The same instance, with the scripted outage driving it on a loop so groups arm, fire, and recover while you watch. |

`dev:tests` is a live exercise, not a pass/fail run. It shows you the whole path
working in the UI.

### Passing flags

`dev/start.js` takes `--tests` and `--reseed` (wipe and re-seed the demo data).
The simplest way to combine them is to skip npm and call the script:

```sh
node dev/start.js --tests --reseed
```

## npm run tests

```sh
npm run tests
```

Runs everything in `tests/`. Notably `tests/action-runs.test.js` drives the action
run engine against real sockets (a mock target server on an ephemeral port), so
it pins the behaviour that's easy to break:

- a stage, with more than one step, run **at once**, two 1.2s steps cost ~1.2s, not 2.4s
- a step's timeout is a **give-up limit**, not a wait. A step with a 30s limit
  against an instant target returns in milliseconds
- a step that outlasts its limit fails, and the run says so
- `on_failure: stop` halts the sequence; `continue` finishes it and still
  reports failure
- pause holds at the **next stage boundary** (never mid-step) and resume carries on
- cancel drops the remaining stages; the stage already running still finishes
- stages are **5s apart by default**, and the first stage still starts at once
- the gap between stages is reported on the run while it's held, and counted in
  the finish estimate
- cancel cuts a gap short — and a run cancelled mid-stage never enters the next
  one — while a stray resume does not
- a **wait step** inside a stage gates it: the steps above it run, the wait is
  held, and only then do the steps below it start. The batches on either side
  still run in parallel within themselves
- cancelling during a wait step leaves everything below it unrun, and a wait
  counts neither as a pass nor a fail
- controls refuse politely once a run is over
- `markInterruptedRuns()` closes out runs a stopped process left behind
- run history outlives its action group, and prunes with retention (but a live
  run is never pruned)

`tests/outage-lifecycle.test.js` covers the whole outage path end to end. Healthy 
endpoints, both fail, the group arms, its grace period elapses, its
action group actually runs, the endpoints recover, the group disarms, and a
second outage fires again. It writes the endpoint states the poller would write
and lets the real watcher react, dating the outage a minute back so a
minutes-long feature can be tested in seconds.

Add to these files when you touch `server/actionRuns.js` or `server/shutdown.js`.

The rest cover what each page configures:

| File | Page | What it pins |
| --- | --- | --- |
| `endpoints.test.js` | Flatline | Endpoints and group membership, `expect_status` / `expect_json`, check timeouts, and the real poller flipping state only once the threshold is met |
| `action-config.test.js` | Actions | Targets and staged groups: stage and step order, a target reused across stages, what a delete takes with it, and the stage's "counts as failed when…" rule |
| `config-security.test.js` | Config | Key rotation and its crash recovery, the optional login and its rate limit, the Host allowlist |
| `config-transfer.test.js` | Config | Export, import, reset, and backup restore |
| `notify.test.js` | Notifications | Channel config validation |

The endpoints file takes ~15s: the poller's floor is one check every 5s, so
watching a threshold actually trip cannot be hurried.

## npm run dev

```sh
npm run dev                         # healthy instance to click around in
npm run dev:tests                   # ...plus the scripted outage on a loop
node dev/start.js --reseed          # either form, on fresh demo data
node dev/start.js --tests --reseed
```

This starts mock targets on `127.0.0.1:3198`, seeds demo data (only when the
database is empty, unless `--reseed`), and serves the app on
<http://localhost:3131> against **`data/dev`**  directory; the production `data/`
directory is never touched.

Without `--tests` every endpoint reports healthy and stays that way, so nothing
arms underneath you while you're editing a form or trying the Run now button.

The mock target routes: `/up` (200), `/down` (500), `/slow?ms=N` (200 after N
ms), `/hang` (never answers, for watching a step hit its limit), and
`/scenario` (follows the outage cycle below).

### The outage cycle (`--tests` only)

`npm run dev:tests` runs a scripted outage on a loop, so endpoints are seen
healthy before they fail. Each phase is announced in the console (`[dev] scenario: DOWN for 120s — …`).

| Phase | Length | What should happen |
| --- | --- | --- |
| UP | 60s | "UPS management" and "Lab API" report UP; no group armed |
| DOWN | 120s | ~20s in both go DOWN and their groups arm; ~60s later the grace period elapses and the action groups run |
| UP | 90s | ~20s in both go UP again and their groups disarm |

Then it repeats, so leaving it open keeps exercising the whole path. The cycle is
`SCENARIO` in [`dev/mock-targets.js`](../dev/mock-targets.js); durations assume
the seeded 10s interval, thresholds of 2, and 1 minute grace.

### What the seed gives you

| Thing | Behaviour |
| --- | --- |
| Office router (ICMP 127.0.0.1) | stays up the whole test (ICMP can't be scripted) |
| UPS management (HTTP `/scenario`) | **follows the outage cycle** under `--tests`; healthy without it |
| Lab API (HTTP `/scenario`) | **follows the outage cycle** under `--tests`; healthy without it |
| NAS web UI (HTTP `/up`) | stays up |
| Flatline group "Power loss" | ALL mode, 1 min grace. Both members follow the cycle, so it arms only during the outage |
| Flatline group "Lab services" | ANY mode, 1 min grace. The always-up NAS never trips it; Lab API does |
| Action group "Graceful shutdown" | 3 stages, first one ~6s, long enough to pause and cancel. 15s and 10s gaps between stages; stage 2 is split by a 20s wait, so the cluster is told only after the Windows host has had time to go down |
| Action group "Failure demo" | stage 1 always fails with `on_failure: stop` |
| Action group "Quick notify" | one instant stage, no gaps |

Under `--tests` every completed run is also checked against the waits its stages
ask for, and the console says so: `[dev] waits held: "Graceful shutdown" took
51.2s against 45.0s of waits`. `NOT HELD` means the run finished quicker than its
own waits allow — that is a regression in `server/actionRuns.js`.

### Checklist

**Dashboard**

- [ ] Group by defaults to **Flatline group** on a browser that has never set it.
- [ ] Clicking a group heading folds that section's cards away; the chevron
      turns, the choice survives a refresh, and each grouping mode remembers
      its own sections.
- [ ] The split row sits between the endpoint cards and Recent events, its two
      cards are the same height, and it stacks to one column under ~900px wide.
- [ ] Clicking **either** the Action groups or Action runs header collapses
      **both** and the choice survives a refresh.
- [ ] Left card lists every action group with its stage count, its target
      summary (`n/m targets up`, plus `down` / `disabled` when non-zero), the
      Flatline groups that run it, and its last run.
- [ ] "Run now" asks for confirmation, then the run appears on the right.
- [ ] "Run now" is disabled while that group is running, and for a group with
      no targets.
- [ ] Within about a minute "Lab services" arms, then triggers on its own, two
      runs appear without anyone pressing anything.
- [ ] Once there are more than three runs, the runs list shows three and
      scrolls; same for action groups (add a fourth to see it). Neither card
      grows down the page.
- [ ] Scroll one of those lists, then wait for a refresh, it should stay where you
      left it.
- [ ] Recent events shows eight rows and scrolls to the rest; the heading
      stays put.
- [ ] Clicking the Recent events heading folds it away on its own — the action
      cards are unaffected — and the choice survives a refresh.
- [ ] An armed group's banner has an × that clears it, the banner doesn't come
      back on the next refresh, and it does come back when the group triggers,
      or when it recovers and fails again.

**A live run (use "Graceful shutdown")**

- [ ] Status, `stage n of m`, and start / "done by … at the latest" all show.
- [ ] Step chips show every target in the current stage, flipping ⋯ → ✓ / ✕ as
      each lands (they run together, so several move at once).
- [ ] Between stages the run reads `Waiting 15s before stage 2 of 3` and stays
      RUNNING — a gap is not a pause.
- [ ] Stage 2's chips move in waves: `✓ Windows host`, then `⋯ wait 20s` while
      `· k8s cluster` sits pending, then the cluster runs. Nothing below a wait
      starts before it is up.
- [ ] Pause → the note reads "pausing after the current stage…", the run keeps
      going, and only at the stage boundary does it become PAUSED.
- [ ] A paused run stays paused; the button now reads Resume, and it continues.
- [ ] Cancel asks first, says "cancelling after the current stage…", then
      finishes as CANCELLED without running the remaining stages.
- [ ] With nothing running, the card shows the recent runs instead.
- [ ] Restart the server mid-run: that run reads INTERRUPTED, not stuck RUNNING.

**Actions page**

- [ ] Disable a target that a group uses, then run that group: its chip reads
      ⊘ and the events list says the step was skipped. Nothing is sent to it,
      and the stage is not marked failed on its account.
- [ ] Each step row reads `give up after [n] s`, and hovering the input explains it.
- [ ] A stage header shows `Stage n · takes up to Ns` and nothing else, and it
      updates when a step's value changes. With no waits it tracks the slowest
      step; add one and it adds up (batch + wait + batch).
- [ ] Adding a stage puts a `⏱ wait [5] s before Stage n` row above it — never
      above stage 1 — and editing it re-labels 0 as "no pause".
- [ ] `+ Add wait` adds a dashed `⏱ Wait for [n] s` row inside the stage. With a
      step below it, it reads "everything below starts after this"; as the last
      row, "holds the stage open at the end". It survives save + reload.
- [ ] Every step row has ↑ / ↓ that move it within its stage (disabled at the
      ends), so a wait can be dropped between two targets without removing them.
      The new order survives save + reload, and changes what actually runs when.
- [ ] The group table's Stages column reads `1. a + b, wait 20s, c  →(15s)→  2. d`
      — `+` runs together, `,` follows a wait, `→` separates stages.

**Notifications**

- [ ] A channel offers "Action group run started / completed / FAILED", and a
      new channel has FAILED ticked by default.
- [ ] Subscribe one to run FAILED, then cancel a run: it delivers, with
      CANCELLED in the message. A completed run does not reach it.

**One edit form at a time**

- [ ] Actions: Edit an action group → the action target form folds away, and
      the other way round.
- [ ] Flatline: Edit a Flatline group → the endpoint form folds away, and the
      other way round.
