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
| Action group "Graceful shutdown" | 3 stages, first one ~6s, long enough to pause and cancel |
| Action group "Failure demo" | stage 1 always fails with `on_failure: stop` |
| Action group "Quick notify" | one instant stage |

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

**A live run (use "Graceful shutdown")**

- [ ] Status, `stage n of m`, and start / "done by … at the latest" all show.
- [ ] Step chips show every target in the current stage, flipping ⋯ → ✓ / ✕ as
      each lands (they run together, so several move at once).
- [ ] Pause → the note reads "pausing after the current stage…", the run keeps
      going, and only at the stage boundary does it become PAUSED.
- [ ] A paused run stays paused; the button now reads Resume, and it continues.
- [ ] Cancel asks first, says "cancelling after the current stage…", then
      finishes as CANCELLED without running the remaining stages.
- [ ] With nothing running, the card shows the recent runs instead.
- [ ] Restart the server mid-run: that run reads INTERRUPTED, not stuck RUNNING.

**Actions page**

- [ ] The Stages help explains "give up after" as a cut-off, not a delay.
- [ ] Each step row reads `give up after [n] s`, and hovering the input explains it.
- [ ] A stage header shows `takes up to Ns`, tracking the slowest step, and
      updates when a step's value changes.

**One edit form at a time**

- [ ] Actions: Edit an action group → the action target form folds away, and
      the other way round.
- [ ] Flatline: Edit a Flatline group → the endpoint form folds away, and the
      other way round.
