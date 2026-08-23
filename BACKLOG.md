# Backlog

Known gaps deliberately left for later. Each entry: **what**, **why deferred**, **what unblocks it**, **where**.

## The remaining page modules are still untested

**Targeted at 1.0**, the next release.

**What:** `actions.js`, `config.js` and `flatline.js` have no tests. Nothing asserts
that the Actions page's Restore panel reveals the right fields per method, that the
relay-reach warning fires, or that each page wires its own forms to the right elements.
The shared machinery underneath them (`crud.js`, `dom.js`) and the dashboard are covered.

Do them cheapest-first: `flatline.js` (smallest, already spiked), then `config.js`, then
`actions.js` (largest, and the only one needing a source change — see below).

**Why deferred:** Scope — 0.6.1 covered `dashboard.js` only. No architectural obstacle
is left; this is now writing tests. `flatline.js` was spiked end-to-end to confirm that,
booting against its real page and rendering both tables.

**What unblocks it:** `tests/dashboard-ui.test.js` is the pattern — stub `globalThis.fetch`
with canned API payloads, enable `node:test`'s `mock.timers` (these pages arm 20s poll
loops that would otherwise keep the test process alive), then import and drive the page.
Two differences from the dashboard, both settled:

1. These three bind to static markup at module scope (`document.getElementById('target-form')`
   and friends, `actions.js:72`), so the test must load the real `public/<page>.html` into
   jsdom rather than hand-write containers. jsdom parses it and does not run its
   `<script type="module">`, so the test still controls when the module is imported. This
   is the more assertive option anyway — it catches markup and script drifting apart.
2. Loading the real HTML brings the site header with it, so `theme.js` reaches
   `window.matchMedia`, which jsdom does not implement. Needs a stub in
   `tests/helpers/jsdom-env.js` (jsdom documents this as a deliberate omission).

`actions.js` additionally cannot be imported in Node at all today, because of two absolute
specifiers, `/shared/net.js` and `/shared/restoreSecrets.js`. No loader hook is needed:
since `public/` is served at `/` and `shared/` at `/shared/`, a relative `../../shared/net.js`
resolves to `/shared/net.js` in the browser and to the real file on disk in Node — verified
both ways. Changing the two specifiers is the whole fix, and it belongs with the actions.js
tests, since nothing else would exercise it.

**Decide before starting:** every page module is an entry point that does its work on
import — `initHeaderAuth()`, `void refreshAll()` and a `setInterval` all run at top level,
which is the root cause of everything above. Moving those into an exported `init()` that
each page's HTML calls would make the modules ordinarily testable instead of testable-
via-harness. That is a real refactor across all four page modules, and it is **not decided**.
It matters here only because of the order: refactoring first means writing each test suite
once, and doing it after means revisiting suites that were written against the boot-on-import
shape. Settle it before the first test is written, not between suites.

**Where:** `public/scripts/{actions,config,flatline}.js`, `public/scripts/actions.js:13-14`
(the specifiers), `public/scripts/dashboard.js:10,826` (the boot-on-import shape),
`tests/dashboard-ui.test.js` (the pattern to copy), `tests/helpers/jsdom-env.js`.
