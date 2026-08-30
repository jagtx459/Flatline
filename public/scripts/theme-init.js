// Applies stored UI state before first paint (no flash). Kept as an external
// 'self' script because the CSP forbids inline scripts. Must run synchronously
// in <head> — no defer/module — so it stamps the root element before the body
// renders. The modules that own each piece re-apply it and keep it in sync once
// they load; everything here is a stamp on <html> that CSS reads, because at
// this point the body does not exist yet.
try {
  var t = localStorage.getItem('flatline.theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch (e) {}

// The config page's sub-tab. initTabs picks it up too, but it runs in a deferred
// module — so without this the General panel paints and is then swapped out for
// whichever tab you were last on. Same precedence as initTabs: a hash beats the
// stored choice. Set on every page, since this script is shared; the panels only
// exist on /config, and style.css matches only the three real panel names, so a
// stale or bogus value falls through to the panel the markup already shows.
// initTabs removes the stamp when it takes over — see dom.js.
try {
  var tab = location.hash.slice(1) || localStorage.getItem('flatline:tab:config');
  if (tab) document.documentElement.setAttribute('data-tab-config', tab);
} catch (e) {}

// How much room the armed/triggered banners took on the page just left, so this
// one can hold it open. They sit above everything and only arrive a round trip
// in, so without this the whole page lurches downward as they land. A guess, and
// only about layout — it claims nothing about what is armed, and banners.js
// drops it as soon as it knows. See #banners in style.css.
try {
  var reserved = Number(sessionStorage.getItem('flatline.banners.height'));
  if (reserved > 0) {
    document.documentElement.style.setProperty('--banners-reserved', reserved + 'px');
  }
} catch (e) {}
