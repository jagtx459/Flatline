// Applies stored UI state before first paint (reduce flashing)
try {
  var t = localStorage.getItem('flatline.theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch (e) {}

try {
  var tab = location.hash.slice(1) || localStorage.getItem('flatline:tab:config');
  if (tab) document.documentElement.setAttribute('data-tab-config', tab);
} catch (e) {}

try {
  var reserved = Number(sessionStorage.getItem('flatline.banners.height'));
  if (reserved > 0) {
    document.documentElement.style.setProperty('--banners-reserved', reserved + 'px');
  }
} catch (e) {}
