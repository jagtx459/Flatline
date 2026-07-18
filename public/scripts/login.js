import { login, getAuthStatus } from './api.js';
import { initHeaderAuth } from './header.js';

initHeaderAuth();

const $form = document.getElementById('login-form');
const $error = document.getElementById('login-error');
const $submit = document.getElementById('login-submit');

// Landed here with auth disabled or an existing session? Straight to the dashboard.
void (async () => {
  try {
    const s = await getAuthStatus();
    if (!s.auth_required || s.authenticated) location.href = '/';
  } catch { /* stay on the login page */ }
})();

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    $error.textContent = '';
    $submit.disabled = true;
    try {
      await login($form.elements.namedItem('password').value);
      location.href = '/';
    } catch (err) {
      $error.textContent = err.message;
      $submit.disabled = false;
    }
  })();
});
