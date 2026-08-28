/**
 * Last-known page data, kept for the length of the browser session so a tab
 * switch paints something immediately instead of an empty page.
 *
 * Every page here boots the same way: static markup renders, then the module
 * asks the API for its data and only then has anything to show. That second
 * step is a network round trip, and over a VPN it is the difference between a
 * tab switch feeling instant and feeling slow. A snapshot fills the gap: the
 * page draws what it last had, and the live payload replaces it a moment later.
 *
 * Two rules keep that honest, and pages must not bend them:
 *
 *  - A snapshot older than MAX_AGE_MS is ignored outright. Flatline reports on
 *    things that go down, and there is no version of this worth showing beyond
 *    a minute.
 *  - Live operational state — an armed or triggered group, a restore in
 *    progress — is never drawn from a snapshot, only from a live payload. Those
 *    are exactly the things that must not be one navigation out of date. Each
 *    page carves its own out; see renderBanners in dashboard.js.
 *
 * Everything a snapshot does draw already carries its own timestamps ("checked
 * 12s ago"), so a slightly old view says how old it is, the same way the live
 * page does between its polls.
 *
 * sessionStorage, not localStorage: this is a within-session convenience, and
 * it should not outlive the tab.
 */

const MAX_AGE_MS = 60_000;
const PREFIX = 'flatline.snap.';

/** The data this page last saved, or null if there is none fit to use. */
export function loadSnapshot(key) {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    return Date.now() - ts <= MAX_AGE_MS ? data : null;
  } catch {
    // Unavailable (private mode), or written by an older version — either way
    // the page just loads the way it always did.
    return null;
  }
}

/**
 * Saves what `get` returns when the page is navigated away from.
 *
 * On the way out rather than after every poll: leaving is the moment the data
 * is freshest, and it keeps serializing a large dashboard payload off the
 * 10-second refresh loop. `get` returns null when there is nothing worth
 * keeping — a page that never finished its first load must not persist a
 * half-populated view.
 */
export function saveSnapshotOnExit(key, get) {
  window.addEventListener('pagehide', () => {
    try {
      const data = get();
      if (data == null) return;
      sessionStorage.setItem(PREFIX + key, JSON.stringify({ ts: Date.now(), data }));
    } catch {
      // Over quota, or storage is unavailable. Losing a snapshot costs a
      // round trip on the way back, nothing more.
    }
  });
}
