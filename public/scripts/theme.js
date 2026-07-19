// Header dark-mode toggle. The theme follows the OS until the user clicks the
// toggle, after which their choice is remembered in localStorage. A tiny inline
// script in each page's <head> applies the stored choice before first paint (no
// flash); this module keeps it in sync and wires the button.

const KEY = 'flatline.theme';

// Each icon shows the theme you'd switch TO: a sun while dark, a moon while light.
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';

function effectiveTheme() {
  const stored = localStorage.getItem(KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateIcon(btn, theme) {
  btn.innerHTML = theme === 'dark' ? SUN : MOON;
}

/** Wires the header's #header-theme toggle. Safe to call on pages without one. */
export function initThemeToggle() {
  const btn = document.getElementById('header-theme');
  if (!btn) return;

  let theme = effectiveTheme();
  updateIcon(btn, theme);

  btn.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, theme);
    document.documentElement.dataset.theme = theme;
    updateIcon(btn, theme);
  });
}
