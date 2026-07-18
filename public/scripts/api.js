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

export function getDashboard(hours) {
  return request(`/api/dashboard?hours=${encodeURIComponent(hours)}`);
}

export function getVersion() {
  return request('/api/version');
}

// endpoints
export function listEndpoints() {
  return request('/api/endpoints');
}
export function createEndpoint(input) {
  return request('/api/endpoints', { method: 'POST', body: JSON.stringify(input) });
}
export function updateEndpoint(id, input) {
  return request(`/api/endpoints/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}
export function deleteEndpoint(id) {
  return request(`/api/endpoints/${id}`, { method: 'DELETE' });
}
export function testEndpoint(input) {
  return request('/api/endpoints/test', { method: 'POST', body: JSON.stringify(input) });
}

// Flatline groups
export function listGroups() {
  return request('/api/groups');
}
export function createGroup(input) {
  return request('/api/groups', { method: 'POST', body: JSON.stringify(input) });
}
export function updateGroup(id, input) {
  return request(`/api/groups/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}
export function deleteGroup(id) {
  return request(`/api/groups/${id}`, { method: 'DELETE' });
}

// action targets
export function listActionTargets() {
  return request('/api/actions/targets');
}
export function createActionTarget(input) {
  return request('/api/actions/targets', { method: 'POST', body: JSON.stringify(input) });
}
export function updateActionTarget(id, input) {
  return request(`/api/actions/targets/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}
export function deleteActionTarget(id) {
  return request(`/api/actions/targets/${id}`, { method: 'DELETE' });
}
export function testActionTarget(input) {
  return request('/api/actions/targets/test', { method: 'POST', body: JSON.stringify(input) });
}
export function runActionTarget(id) {
  return request(`/api/actions/targets/${id}/run`, { method: 'POST' });
}
export function restoreActionTarget(id) {
  return request(`/api/actions/targets/${id}/restore`, { method: 'POST' });
}

// action groups
export function listActionGroups() {
  return request('/api/actions/groups');
}
export function createActionGroup(input) {
  return request('/api/actions/groups', { method: 'POST', body: JSON.stringify(input) });
}
export function updateActionGroup(id, input) {
  return request(`/api/actions/groups/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}
export function deleteActionGroup(id) {
  return request(`/api/actions/groups/${id}`, { method: 'DELETE' });
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
  return request('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
}
export function logout() {
  return request('/api/logout', { method: 'POST' });
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
  return request('/api/config/key/rotate', { method: 'POST' });
}
export function setKey(key) {
  return request('/api/config/key', { method: 'PUT', body: JSON.stringify({ key }) });
}

// notification channels
export function listNotificationChannels() {
  return request('/api/notifications');
}
export function createNotificationChannel(input) {
  return request('/api/notifications', { method: 'POST', body: JSON.stringify(input) });
}
export function updateNotificationChannel(id, input) {
  return request(`/api/notifications/${id}`, { method: 'PUT', body: JSON.stringify(input) });
}
export function deleteNotificationChannel(id) {
  return request(`/api/notifications/${id}`, { method: 'DELETE' });
}
export function testNotificationChannel(input) {
  return request('/api/notifications/test', { method: 'POST', body: JSON.stringify(input) });
}
