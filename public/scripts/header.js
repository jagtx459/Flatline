import { getAuthStatus, logout, getVersion } from './api.js';

/** Re-checks whether a login is required and shows/hides the header's Log out button accordingly. */
export async function refreshHeaderAuth() {
  const btn = document.getElementById('header-logout');
  if (!btn) return;
  try {
    const s = await getAuthStatus();
    btn.style.display = s.auth_required ? '' : 'none';
  } catch {
    // Leave it as-is — a failed status check shouldn't surface a broken button.
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
    // Leave it blank — a failed version fetch shouldn't break the header.
  }
}

/** Wires the header's Log out button once and does the initial visibility check. */
export function initHeaderAuth() {
  void initHeaderVersion();

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
