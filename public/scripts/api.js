async function request(path, init) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  // Session expired or auth just enabled — every page bails to the login screen.
  if (res.status === 401 && location.pathname !== '/login') {
    location.href = '/login';
    throw new Error('authentication required');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && typeof body === 'object' && 'error' in body
      ? String(body.error)
      : `request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

const post = (path, input) => request(path, { method: 'POST', body: JSON.stringify(input) });

/**
 * The calls a CRUD resource answers to, mirroring the RESOURCES table the server
 * routes them with (see server/index.js). The shape is deliberately what
 * initEntityForm in crud.js expects, so a form can be handed one of these whole.
 *
 * `test` only exists on the resources whose server route has one — the others
 * simply never call it.
 */
function resource(base) {
  return {
    list: () => request(base),
    create: (input) => post(base, input),
    update: (id, input) => request(`${base}/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
    remove: (id) => request(`${base}/${id}`, { method: 'DELETE' }),
    test: (input) => post(`${base}/test`, input)
  };
}

export const endpoints = resource('/api/endpoints');
export const groups = resource('/api/groups');            // Flatline groups
export const actionTargets = resource('/api/actions/targets');
export const actionGroups = resource('/api/actions/groups');
export const notificationChannels = resource('/api/notifications');
export const relays = resource('/api/relays');

// ---- beyond plain CRUD ----

export function getDashboard(hours) {
  return request(`/api/dashboard?hours=${encodeURIComponent(hours)}`);
}

export function getVersion() {
  return request('/api/version');
}

/** Runs a target's real configured action now, outside any group or grace period. */
export function runActionTarget(id) {
  return post(`/api/actions/targets/${id}/run`);
}
/** Runs a target's restore sequence now. */
export function restoreActionTarget(id) {
  return post(`/api/actions/targets/${id}/restore`);
}
/** Which part of its restore sequence a target is on, while one is running. */
export function getRestoreStatus(id) {
  return request(`/api/actions/targets/${id}/restore`);
}
/** Runs a whole action group now. */
export function runActionGroup(id) {
  return post(`/api/actions/groups/${id}/run`);
}

// action runs (an execution of an action group) — the list itself rides along
// on the dashboard payload; these are the controls.
export function pauseActionRun(id) {
  return post(`/api/actions/runs/${id}/pause`);
}
export function resumeActionRun(id) {
  return post(`/api/actions/runs/${id}/resume`);
}
export function cancelActionRun(id) {
  return post(`/api/actions/runs/${id}/cancel`);
}

// settings
export function getSettings() {
  return request('/api/settings');
}
export function putSettings(patch) {
  return request('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
}

// auth
export function getAuthStatus() {
  return request('/api/auth');
}
export function login(password) {
  return post('/api/login', { password });
}
export function logout() {
  return post('/api/logout');
}

// site security (password + allowed hosts)
export function getSecurityConfig() {
  return request('/api/config/security');
}
export function setSitePassword(password) {
  return request('/api/config/password', { method: 'PUT', body: JSON.stringify({ password }) });
}
export function removeSitePassword() {
  return request('/api/config/password', { method: 'DELETE' });
}

// encryption key
export function getKeyStatus() {
  return request('/api/config/key');
}
export function rotateKey() {
  return post('/api/config/key/rotate');
}
export function setKey(key) {
  return request('/api/config/key', { method: 'PUT', body: JSON.stringify({ key }) });
}

// backup / restore & config transfer
export function exportConfig() {
  return request('/api/config/export');
}
export function importConfig(data) {
  return post('/api/config/import', data);
}
export function resetApp() {
  return post('/api/config/reset');
}

/** Shared 401->login + error handling for the non-JSON (binary) backup routes. */
async function binaryRequest(path, init) {
  const res = await fetch(path, init);
  if (res.status === 401 && location.pathname !== '/login') {
    location.href = '/login';
    throw new Error('authentication required');
  }
  return res;
}

/** Downloads the SQLite DB file as a Blob (backup). */
export async function downloadBackup() {
  const res = await binaryRequest('/api/config/backup');
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `request failed (${res.status})`);
  }
  return res.blob();
}

/** Uploads a DB file (File/Blob) to restore; the server reopens the DB in place. */
export async function restoreBackup(file) {
  const res = await binaryRequest('/api/config/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `request failed (${res.status})`);
  return body;
}
