# Backlog

Known gaps deliberately left for later. Each entry: **what**, **why deferred**, **what unblocks it**, **where**.

## The page modules themselves are still untested

**What:** `tests/crud-ui.test.js` and `tests/dom-ui.test.js` cover the shared machinery
(`crud.js`, `dom.js`) under jsdom, but the three page modules that build on it —
`actions.js`, `config.js`, `flatline.js` — have no tests. Nothing asserts that the
Actions page's Restore panel reveals the right fields per method, that the relay-reach
warning fires, or that each page wires its own forms to the right elements.

**Why deferred:** Two obstacles, both surmountable but neither trivial:

1. They cannot be imported in Node at all. `actions.js` imports `/shared/net.js` — correct
   for the browser, but Node resolves a leading `/` against the filesystem root
   (`C:\shared\net.js`) and fails with `ERR_MODULE_NOT_FOUND`.
2. They call `fetch` at import time (`initHeaderAuth()`, `refreshAll()`), so a test would
   have to stand in for the whole API before importing.

**What unblocks it:** A resolve hook registered with `module.register()` that maps
`/shared/*` to the real path, plus a `globalThis.fetch` stub returning canned API
payloads. Roughly 30 lines in `tests/helpers/`. The existing jsdom harness
(`tests/helpers/jsdom-env.js`) already handles the DOM half.

**Where:** `public/scripts/{actions,config,flatline}.js`, `tests/helpers/jsdom-env.js`.

## Layout-dependent UI is out of reach under jsdom

**What:** jsdom implements no rendering, so `getBoundingClientRect()` returns zeroes.
Three behaviours therefore have no coverage: the help popover's flip when it would run
off the right edge (`dom.js` `initHelp`), tooltip placement (`showTooltip`), and the
latency chart's sizing (`dashboard.js`).

**Why deferred:** Testing these needs a real browser engine. Playwright is only two npm
packages but downloads browser binaries and adds CI time — a bigger commitment than the
three behaviours currently justify.

**What unblocks it:** Adding Playwright and driving the real pages against a spawned
server, the way `tests/api-routes.test.js` already spawns one. That would also subsume
the previous entry.

**Where:** `public/scripts/dom.js` (`initHelp`, `showTooltip`), `public/scripts/dashboard.js`.

## dashboard.js has no tests

**What:** The dashboard's rendering — banners, countdowns, endpoint cards, the beats
strip, the run list and its pause/resume/cancel controls — is untested. It was outside
the 0.6.0 refactor, so nothing there changed, but it is the largest untested page module.

**Why deferred:** Out of scope for the refactor pass; it shares no code with the
`crud.js` machinery the tests were written for.

**Where:** `public/scripts/dashboard.js`.
