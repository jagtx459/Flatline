/**
 * The armed/triggered notices, on every page.
 *
 * A group arming is the one thing this application exists to tell you about, and
 * it does not stop mattering because you happen to be editing a relay when it
 * happens. So the banners are not the dashboard's — every page carries them, and
 * they say the same thing in the same place wherever you are.
 *
 * Two ways in, because the dashboard already has this data:
 *
 *  - initBanners() for a page that fetches group states itself, as part of a
 *    larger payload. It hands them over with update().
 *  - watchBanners() for a page that has no reason to fetch anything else. It
 *    reads the small /api/groups/states route on its own.
 *
 * Both draw only live data. There is no snapshot path here on purpose: an armed
 * group one navigation out of date is exactly the wrong thing to show, and a
 * page that has not heard yet is better off saying nothing for a moment.
 */

import { el, clear, fmtDateTime } from './dom.js';
import { getGroupStates } from './api.js';
import { onServerChange } from './stream.js';

/** The stream is the fast path; this only catches what it missed (a dropped
 *  connection, a proxy that ate it). */
const POLL_MS = 15_000;

/** Where the space to hold open for the next page is left. */
const RESERVE_KEY = 'flatline.banners.height';

/**
 * Wires the page's #banners container, which every page that calls this carries.
 * Returns { update } — call it with the group states and the server clock they
 * were read at.
 */
export function initBanners() {
  const container = document.getElementById('banners');

  // Hand the next page the height to hold open while its own banners are in
  // flight; theme-init.js reads it before that page paints.
  window.addEventListener('pagehide', () => {
    try {
      sessionStorage.setItem(RESERVE_KEY, String(container.offsetHeight));
    } catch {
      // Unavailable (private mode). The next page reserves nothing and lurches
      // the way it always did — no worse than not having tried.
    }
  });

  /** Stop holding the reserved space: what is on the page now is the truth,
   *  whether that is two banners or none. */
  function release() {
    document.documentElement.style.removeProperty('--banners-reserved');
  }

  // Banners the user has cleared, by group and state. Kept in memory only: a
  // dismissal hides a notice, it must never hide it for good.
  const dismissed = new Set();
  // The server's clock and ours at the moment we last heard, so the countdown
  // ticks against the server's deadline without inheriting any clock skew.
  let serverNow = 0;
  let fetchedAt = 0;

  function countdownText(deadlineTs) {
    if (!deadlineTs || !serverNow) return '';
    const remaining = Math.max(0, deadlineTs - (serverNow + (Date.now() - fetchedAt)));
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  // Runs only while a countdown is on screen, which is almost never — an idle
  // page has no armed group and so nothing to tick.
  let ticker = null;
  function retime() {
    const counting = container.querySelector('[data-deadline]') !== null;
    if (counting && ticker === null) {
      ticker = setInterval(() => {
        for (const node of container.querySelectorAll('[data-deadline]')) {
          const deadline = Number(node.dataset.deadline);
          if (deadline) node.textContent = countdownText(deadline);
        }
      }, 1000);
    } else if (!counting && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function update(groups, now) {
    serverNow = now;
    fetchedAt = Date.now();
    clear(container);
    const live = new Set();

    for (const g of groups) {
      if (!g.armed) continue;

      // A group escalating from armed to triggered is a new notice, so clearing
      // the countdown doesn't also swallow "TRIGGERED".
      const key = `${g.group_id}:${g.triggered ? 'triggered' : 'armed'}`;
      live.add(key);
      if (dismissed.has(key)) continue;

      const banner = el('div', { class: `banner ${g.triggered ? 'triggered' : 'armed'}` });
      const actions = g.action_group_names.length
        ? g.action_group_names.join(', ')
        : 'no action groups assigned';

      if (g.triggered) {
        banner.append(
          el('span', { class: 'icon' }, '⛔'),
          el('span', {}, `"${g.name}" TRIGGERED — running action group(s): ${actions}.`),
          el('span', { class: 'countdown' }, g.triggered_ts ? fmtDateTime(g.triggered_ts) : '')
        );
      } else {
        const cd = el('span', { class: 'countdown' }, countdownText(g.deadline_ts));
        cd.dataset.deadline = String(g.deadline_ts ?? '');
        banner.append(
          el('span', { class: 'icon' }, '⚠️'),
          el('span', {}, `Group "${g.name}" failed (${g.down_count}/${g.endpoint_count} down) — will run: ${actions}.`),
          cd
        );
      }

      const close = el('button', {
        class: 'banner-x', type: 'button', title: 'Clear', 'aria-label': 'Clear'
      }, '×');
      close.addEventListener('click', () => {
        dismissed.add(key);
        banner.remove();
        retime(); // it may have been the last countdown on the page
      });
      banner.append(close);

      container.append(banner);
    }

    // Forget the dismissal once the group recovers, so a later outage says so.
    for (const key of dismissed) {
      if (!live.has(key)) dismissed.delete(key);
    }

    retime();
    release();
  }

  return { update, release };
}

/**
 * initBanners for a page that has no group states of its own: this fetches
 * them, follows the change stream, and polls as a backstop.
 *
 * It also owns that page's stream, since the banners are the one thing on every
 * page — so anything else that wants the same nudge rides along on `onChange`
 * rather than opening a second connection.
 *
 * `health` says the page shows action-target connectivity dots, which is what
 * puts the server's target poller on its fast cadence — a real connection to
 * every target every ten seconds. The banners alone never need it; see
 * openEventStream in server/index.js.
 */
export function watchBanners({ health = false, onChange } = {}) {
  const { update, release } = initBanners();

  async function load() {
    try {
      const { now, groups } = await getGroupStates();
      update(groups, now);
    } catch (err) {
      // Leave the banners as they are — a failed poll is not news that the
      // outage is over, and blanking them would say exactly that. The reserved
      // space does go, though: holding a gap open for banners that are not
      // coming would leave the page looking broken rather than merely stale.
      release();
      console.error('group states refresh failed:', err);
    }
  }

  void load();
  setInterval(() => void load(), POLL_MS);

  onServerChange(() => {
    void load();
    onChange?.();
  }, { health });
}
