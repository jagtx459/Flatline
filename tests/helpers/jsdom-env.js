import { JSDOM } from 'jsdom';

/**
 * A DOM for the public/ scripts to run against.
 *
 * Those modules are written for a browser: they reach for `document` and
 * `localStorage` as bare globals and are loaded by the page as ES modules. Node
 * has neither, so a test builds a jsdom window and copies the handful of globals
 * they touch onto `globalThis` before importing the module under test.
 *
 * Layout is the known gap — jsdom implements no rendering, so every
 * getBoundingClientRect() is zeroes. The few places that depend on real
 * geometry (the help popover's flip, tooltip placement, chart sizing) cannot be
 * asserted here; everything else can.
 */

/** Globals the public/ scripts use bare. `navigator` is left alone — Node
 *  defines its own read-only one and nothing here needs the DOM's. */
const GLOBALS = [
  'window', 'document', 'location', 'localStorage', 'sessionStorage',
  'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'FileReader', 'Blob', 'URL', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'matchMedia', 'EventSource'
];

const saved = new Map();

/**
 * Installs a fresh DOM. Returns { window, document, cleanup } — call cleanup()
 * (or use the `after` hook) so one test's globals never leak into the next.
 */
export function setupDom(html = '<!doctype html><html><body></body></html>', url = 'http://localhost/') {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;

  // Not implemented by jsdom, and called whenever a form switches to edit mode.
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  // Also not implemented by jsdom (a documented gap). The dashboard opens one
  // for live updates on top of its poll; the poll is what the tests drive, so a
  // stub that connects to nothing is enough to let the module load.
  window.EventSource = class EventSource {
    constructor(url) { this.url = url; }
    addEventListener() {}
    close() {}
  };

  // Another documented jsdom omission, and unavoidable for any page loaded whole:
  // the site header reaches it twice, for its 720px breakpoint and for
  // prefers-color-scheme. Nothing here matches — the wide header and the light
  // theme — which is the plain case every suite but header-ui wants. That one
  // replaces this with a list it can flip; see stubMatchMedia there.
  window.matchMedia = (query) => ({
    media: query,
    matches: false,
    addEventListener() {},
    removeEventListener() {}
  });

  for (const key of GLOBALS) {
    if (!(key in window)) continue;
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value: window[key], writable: true, configurable: true, enumerable: false
    });
  }

  window.localStorage.clear();

  return {
    dom,
    window,
    document: window.document,
    cleanup() {
      window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      saved.clear();
    }
  };
}

/**
 * Imports a module fresh, bypassing the ESM cache, so each test gets a module
 * bound to the DOM that is current — a module that captured `document` at import
 * time would otherwise still point at a closed window.
 *
 * Takes a full URL href, e.g.
 *   importFresh(new URL('../public/scripts/crud.js', import.meta.url).href)
 */
let bust = 0;
export function importFresh(href) {
  return import(`${href}?fresh=${++bust}`);
}

/** A click that bubbles, which is what the delegated listeners expect. */
export function click(node) {
  node.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Lets queued promise callbacks run — the click handlers are all async. */
export function flush(times = 3) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => (++n >= times ? resolve() : setImmediate(tick));
    setImmediate(tick);
  });
}
