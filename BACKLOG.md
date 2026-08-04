# Backlog

Known gaps deliberately left for later. Each entry: **what**, **why deferred**, **what unblocks it**, **where**.

## Notification channels can't subscribe to action-run events

**What:** Starting an action group manually records an `action_run_started`
event, and runs now finish as completed/failed/cancelled/interrupted, but none
of that is offered as a notification trigger. Channels can still only subscribe
to the per-step `action_ok` / `action_failed` events, so a run that is cancelled
or stopped early sends nothing.

**Why deferred:** 0.5.0 scoped the run engine and its dashboard panel; changing
the notification event set wasn't asked for and would touch the per-channel
subscription UI and the stored `events[]` config on every channel.

**What unblocks it:** Decide which run-level events are worth notifying on
(likely `run_started`, `run_finished`, maybe `run_cancelled`), then add them to
`NOTIFY_EVENTS` + `EVENT_LABELS` and map them in `eventToNotifyKind()`. Existing
channels default to no subscription, so no migration is needed.

**Where:** `server/notify.js` (`NOTIFY_EVENTS`, `EVENT_LABELS`,
`eventToNotifyKind`), event emission in `server/actionRuns.js` and the
manual-run route in `server/index.js`; the subscription checkboxes live in
`public/config.html` / `public/scripts/config.js`.
