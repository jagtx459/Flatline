import { getAuthStatus, logout, getVersion } from './api.js';
import { initThemeToggle } from './theme.js';
import { el } from './dom.js';

/** Re-checks whether a login is required and shows/hides the header's Log out button accordingly. */
export async function refreshHeaderAuth() {
  const btn = document.getElementById('header-logout');
  if (!btn) return;
  try {
    const s = await getAuthStatus();
    btn.style.display = s.auth_required ? '' : 'none';
    const sep = document.getElementById('header-menu-sep');
    if (sep) sep.style.display = s.auth_required ? '' : 'none';
  } catch {
    // Leave it as-is, a failed status check shouldn't surface a broken button.
  }
}

/** Fills in the header's version badge (present on every page, including login). */
async function initHeaderVersion() {
  const el = document.getElementById('header-version');
  if (!el) return;
  try {
    const { version } = await getVersion();
    el.textContent = `v${version}`;
  } catch {
    // Leave it blank, a failed version fetch shouldn't break the header.
  }
}

const MENU_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"></path></svg>';

/** Below this the four nav tabs, the brand and the icons no longer fit on one line. */
const NARROW = '(max-width: 720px)';

/**
 * The phone header: a hamburger beside the icons, holding the nav tabs and —
 * under a separator — the Log out button.
 *
 * Both are *moved* into the dropdown rather than copied, so the page still has
 * one nav and one #header-logout however wide the window is, and they move back
 * when it widens again. Nothing is built on the login page, which has no nav.
 */
function initHeaderMenu() {
  const header = document.querySelector('header.site');
  const nav = header?.querySelector('nav');
  const actions = header?.querySelector('.header-actions');
  if (!nav || !actions) return;

  const sep = el('div', { class: 'menu-sep', id: 'header-menu-sep' });
  const panel = el('div', { class: 'header-menu', id: 'header-menu', hidden: '' }, sep);
  const btn = el('button', {
    type: 'button', class: 'icon-link hamburger', id: 'header-menu-btn',
    'aria-controls': 'header-menu', 'aria-expanded': 'false',
    title: 'Menu', 'aria-label': 'Menu'
  });
  btn.innerHTML = MENU_ICON;
  actions.append(btn);
  header.append(panel);

  const logoutBtn = document.getElementById('header-logout');

  function close() {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  const narrow = window.matchMedia(NARROW);
  function place() {
    if (narrow.matches) {
      panel.append(nav, sep);
      if (logoutBtn) panel.append(logoutBtn);
    } else {
      close();
      header.insertBefore(nav, actions);
      if (logoutBtn) actions.insertBefore(logoutBtn, btn);
    }
  }
  narrow.addEventListener('change', place);
  place();

  btn.addEventListener('click', () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    btn.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !e.target.closest('#header-menu, #header-menu-btn')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

/** Wires the header's Log out button once and does the initial visibility check. */
export function initHeaderAuth() {
  void initHeaderVersion();
  initThemeToggle();
  initHeaderMenu();

  const btn = document.getElementById('header-logout');
  if (!btn) return;

  void refreshHeaderAuth();

  btn.addEventListener('click', () => {
    void (async () => {
      try {
        await logout();
      } finally {
        location.href = '/login';
      }
    })();
  });
}
