// Applies the stored theme before first paint (no flash). Kept as an external
// 'self' script because the CSP forbids inline scripts. Must run synchronously
// in <head> — no defer/module — so it sets data-theme before the body renders.
// theme.js wires the toggle and keeps this in sync after load.
try {
  var t = localStorage.getItem('flatline.theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch (e) {}
