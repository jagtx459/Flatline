import {
  listActionTargets, createActionTarget, updateActionTarget, deleteActionTarget, testActionTarget, runActionTarget,
  restoreActionTarget,
  listActionGroups, createActionGroup, updateActionGroup, deleteActionGroup,
  listGroups, updateGroup, listRelays
} from './api.js';
import { el, clear, fmtDateTime, enabledPill, initCollapsible, initDirtyNote, wireFileUpload, confirmDialog, alertDialog } from './dom.js';
import { initHeaderAuth } from './header.js';

initHeaderAuth();

let targets = [];
let igroups = [];
let flatlineGroups = [];
let relays = [];

const KIND_LABELS = { ssh: 'SSH', winrm: 'WinRM', k8s: 'Kubernetes', http: 'HTTP(S)' };
const K8S_ACTION_LABELS = { drain: 'cordon + drain all nodes', custom: 'custom command' };

// Maps a kind's secret field -> form input name.
const SECRET_INPUTS = {
  ssh:  { password: 'ssh_password', private_key: 'ssh_private_key', passphrase: 'ssh_passphrase', sudo_password: 'ssh_sudo_password',
          restore_token: 'ssh_restore_token', restore_password: 'ssh_restore_password' },
  winrm: { password: 'winrm_password', restore_token: 'winrm_restore_token', restore_password: 'winrm_restore_password' },
  k8s:  { token: 'k8s_token', kubeconfig: 'k8s_kubeconfig' },
  http: { token: 'http_token', password: 'http_password', login_password: 'http_login_password' }
};

/** Kinds whose Restore is the wake -> wait -> final step sequence. */
const RESTORE_SEQUENCE_KINDS = ['ssh', 'winrm'];
/** Kinds with a collapsible Restore panel in the form. k8s and http each have
 *  one too, but their sequences are their own — k8s waits for the API server
 *  then undoes; http waits for its login (when it has one) then sends the undo. */
const RESTORE_PANEL_KINDS = [...RESTORE_SEQUENCE_KINDS, 'k8s', 'http'];
const PROTO_LABELS = { ssh: 'SSH', winrm: 'WinRM' };
const DEFAULT_RESTORE_WAIT = 300;

function targetById(id) {
  return targets.find((t) => t.id === id);
}

// ---------- target form ----------

const $form = document.getElementById('target-form');
const $formTitle = document.getElementById('target-form-title');
const $formError = document.getElementById('target-error');
const $formSubmit = document.getElementById('target-submit');
const $formCancel = document.getElementById('target-cancel');
const $formReset = document.getElementById('target-reset');
const $formTest = document.getElementById('target-test');
const $formTestResult = document.getElementById('target-test-result');
const $formSaveNote = document.getElementById('target-save-note');
const $kind = document.getElementById('t-kind');
const $httpScheme = document.getElementById('http-auth-scheme');
const $targetTable = document.getElementById('target-table');
const $sshAuthMethod = $form.elements.namedItem('ssh_auth_method');
const $k8sAuthMethod = $form.elements.namedItem('k8s_auth_method');
const $k8sAction = $form.elements.namedItem('k8s_action');
const targetFormSection = initCollapsible('actions:target-form',
  document.getElementById('target-form-header'), document.getElementById('target-form-body'));
// The Restore panel is the longest part of the form and most targets never
// change it after setup, so each kind's folds away on its own.
for (const kind of RESTORE_PANEL_KINDS) {
  initCollapsible(`actions:restore-${kind}`,
    document.getElementById(`${kind}-restore-header`), document.getElementById(`${kind}-restore-body`));
}
const targetDirty = initDirtyNote($form, document.getElementById('target-dirty'), $formSaveNote);

let editingTargetId = null;
/** Secret fields the user asked to clear on this edit. */
let clearedSecrets = new Set();

function field(name) {
  return $form.elements.namedItem(name);
}

function syncKindSections() {
  const kind = $kind.value;
  for (const section of $form.querySelectorAll('.kind-section')) {
    section.style.display = section.dataset.kind === kind ? '' : 'none';
  }
  syncHttpAuthFields();
  syncSshAuthFields();
  syncK8sAuthFields();
  syncK8sActionFields();
  for (const k of RESTORE_SEQUENCE_KINDS) syncRestoreFields(k);
  $formTestResult.textContent = '';
}

/** The restore sequence's "Once it answers" choice, and — inside its HTTP
 *  option — the fields that particular auth scheme needs. Also the wake step's
 *  packet/relay choice. Scoped to one kind-section, because ssh and winrm each
 *  carry their own copy of the block. */
function syncRestoreFields(kind) {
  const section = $form.querySelector(`.kind-section[data-kind="${kind}"]`);
  const action = field(`${kind}_restore_action`).value;
  for (const node of section.querySelectorAll('[data-restore-action]')) {
    node.style.display = node.dataset.restoreAction === action ? '' : 'none';
  }
  const scheme = field(`${kind}_restore_auth_scheme`).value;
  for (const node of section.querySelectorAll('[data-restore-auth]')) {
    node.style.display = node.dataset.restoreAuth.split(' ').includes(scheme) ? '' : 'none';
  }
  const wakeMode = field(`${kind}_wake_mode`).value;
  for (const node of section.querySelectorAll('[data-wake-mode]')) {
    node.style.display = node.dataset.wakeMode === wakeMode ? '' : 'none';
  }
  renderRelayWarning(kind);
}

/** Dotted-quad -> unsigned 32-bit, or null when it isn't four 0-255 octets —
 *  which is also how a hostname (rather than an IP) is detected. */
function ipToInt(ip) {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out * 256) + n;
  }
  return out;
}

/** Whether `host` falls inside a relay's CIDR. null when it can't be told —
 *  a hostname rather than an address, which Flatline will not resolve here. */
function hostInNetwork(host, cidr) {
  const [net, bits] = String(cidr ?? '').split('/');
  const addr = ipToInt(String(host ?? ''));
  const base = ipToInt(net ?? '');
  const prefix = Number(bits);
  if (addr === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  if (prefix === 0) return true;
  const mask = (0xffff_ffff << (32 - prefix)) >>> 0;
  return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
}

/**
 * Warns when the chosen relay cannot reach the target's address. A magic packet
 * sent to the wrong network fails silently — nothing ever answers one — so this
 * is the only point at which the mistake is visible.
 */
function renderRelayWarning(kind) {
  const note = $form.querySelector(`[data-relay-note="${kind}"]`);
  clear(note);
  note.className = 'hint-row';

  const relayId = field(`${kind}_wake_relay_id`).value;
  if (field(`${kind}_wake_mode`).value !== 'relay' || !relayId) return;

  const relay = relays.find((r) => String(r.id) === relayId);
  if (!relay) return;

  const host = field(`${kind}_host`).value.trim();
  const inside = hostInNetwork(host, relay.network);
  if (inside === true) {
    note.textContent = `✓ ${host} is inside this relay's network (${relay.network}).`;
  } else if (inside === false) {
    note.className = 'error';
    note.textContent = `⚠ ${host} is not inside this relay's network (${relay.network}) — `
      + 'a magic packet sent from there will not reach it. Pick a relay on the target\'s own network.';
  } else if (host) {
    note.textContent = `This relay reaches ${relay.network}. "${host}" is a name, not an address, `
      + 'so Flatline cannot check it here — make sure it resolves inside that network.';
  }
}

/** Fills both relay pickers. Kept as its own pass so the relay list can refresh
 *  without disturbing an edit in progress — the current selection is restored
 *  when the relay still exists, and a relay that has since been deleted stays
 *  visible as a marked option rather than silently becoming "the first one". */
function renderRelayOptions() {
  for (const select of $form.querySelectorAll('[data-relay-picker]')) {
    const chosen = select.value;
    clear(select);
    if (relays.length === 0) {
      select.append(el('option', { value: '' }, 'no relays configured yet'));
    } else {
      select.append(el('option', { value: '' }, 'select a relay…'));
      for (const r of relays) {
        select.append(el('option', { value: String(r.id) },
          `${r.name} (${KIND_LABELS[r.kind] ?? r.kind})${r.enabled ? '' : ' — disabled'}`));
      }
    }
    if (chosen && !relays.some((r) => String(r.id) === chosen)) {
      select.append(el('option', { value: chosen }, `deleted relay ${chosen}`));
    }
    select.value = chosen;
  }
}

function syncHttpAuthFields() {
  const scheme = $httpScheme.value;
  for (const node of $form.querySelectorAll('[data-http]')) {
    const schemes = node.dataset.http.split(' ');
    node.style.display = schemes.includes(scheme) ? '' : 'none';
  }
  syncHttpTokenFields();
}

/** Inside the login block, the one field that names where the token is — a path
 *  into the body, a response header, or a cookie. */
function syncHttpTokenFields() {
  const source = field('http_token_source').value;
  for (const node of $form.querySelectorAll('[data-token-source]')) {
    node.style.display = node.dataset.tokenSource === source ? '' : 'none';
  }
}

function syncSshAuthFields() {
  const method = $sshAuthMethod.value;
  for (const node of $form.querySelectorAll('[data-ssh-auth]')) {
    node.style.display = node.dataset.sshAuth === method ? '' : 'none';
  }
}

function syncK8sAuthFields() {
  const method = $k8sAuthMethod.value;
  for (const node of $form.querySelectorAll('[data-k8s-auth]')) {
    node.style.display = node.dataset.k8sAuth === method ? '' : 'none';
  }
}

function syncK8sActionFields() {
  const action = $k8sAction.value;
  for (const node of $form.querySelectorAll('[data-k8s-action]')) {
    node.style.display = node.dataset.k8sAction === action ? '' : 'none';
  }
}

$kind.addEventListener('change', syncKindSections);
$httpScheme.addEventListener('change', syncHttpAuthFields);
$form.querySelector('[data-token-source-select]').addEventListener('change', syncHttpTokenFields);
$sshAuthMethod.addEventListener('change', syncSshAuthFields);
$k8sAuthMethod.addEventListener('change', syncK8sAuthFields);
$k8sAction.addEventListener('change', syncK8sActionFields);
for (const sel of $form.querySelectorAll('[data-restore-action-select], [data-restore-auth-select], [data-wake-mode-select]')) {
  const kind = sel.dataset.restoreActionSelect ?? sel.dataset.restoreAuthSelect ?? sel.dataset.wakeModeSelect;
  sel.addEventListener('change', () => syncRestoreFields(kind));
}
// The relay-reach warning depends on both the chosen relay and the target's
// own address, so it has to follow the host field too.
for (const kind of RESTORE_SEQUENCE_KINDS) {
  field(`${kind}_wake_relay_id`).addEventListener('change', () => renderRelayWarning(kind));
  field(`${kind}_host`).addEventListener('input', () => renderRelayWarning(kind));
}

// The file inputs live inside $form, so their change events bubble up and mark
// the form dirty via initDirtyNote — no explicit markDirty needed here.
wireFileUpload(
  document.getElementById('ssh-key-upload-btn'),
  document.getElementById('ssh-key-upload'),
  $form.elements.namedItem('ssh_private_key')
);
wireFileUpload(
  document.getElementById('k8s-kubeconfig-upload-btn'),
  document.getElementById('k8s-kubeconfig-upload'),
  $form.elements.namedItem('k8s_kubeconfig')
);

/** Shows "stored" state + a clear toggle next to each secret input. */
function renderSecretStates(kind, storedFields) {
  clearedSecrets = new Set();
  for (const label of $form.querySelectorAll('label.secret')) {
    const state = label.querySelector('.secret-state');
    clear(state);
    const name = label.dataset.secret;
    const isStored = storedFields.includes(name) && label.closest('.kind-section')?.dataset.kind === kind;
    if (!isStored) continue;

    const clearBtn = el('button', { type: 'button', class: 'link-btn' }, 'clear');
    clearBtn.addEventListener('click', () => {
      if (clearedSecrets.has(name)) {
        clearedSecrets.delete(name);
        clearBtn.textContent = 'clear';
        hint.textContent = '· stored ✓ (leave blank to keep) ';
      } else {
        clearedSecrets.add(name);
        clearBtn.textContent = 'undo';
        hint.textContent = '· will be removed on save ';
      }
      targetDirty.markDirty();
    });
    const hint = el('span', {}, '· stored ✓ (leave blank to keep) ');
    state.append(hint, clearBtn);
  }
}

/** The restore-sequence fields, identical for ssh and winrm — only the input
 *  name prefix differs. */
function collectRestore(kind) {
  return {
    auto_restore: field(`${kind}_auto_restore`).checked,
    wol_mac: field(`${kind}_wol_mac`).value,
    wake_mode: field(`${kind}_wake_mode`).value,
    wake_relay_id: Number(field(`${kind}_wake_relay_id`).value) || null,
    wol_broadcast: field(`${kind}_wol_broadcast`).value,
    restore_wait_seconds: Number(field(`${kind}_restore_wait_seconds`).value) || 0,
    restore_action: field(`${kind}_restore_action`).value,
    restore_command: field(`${kind}_restore_command`).value,
    restore_url: field(`${kind}_restore_url`).value,
    restore_method: field(`${kind}_restore_method`).value,
    restore_body: field(`${kind}_restore_body`).value,
    restore_auth_scheme: field(`${kind}_restore_auth_scheme`).value,
    restore_header_name: field(`${kind}_restore_header_name`).value,
    restore_username: field(`${kind}_restore_username`).value
  };
}

function fillRestore(kind, c) {
  field(`${kind}_auto_restore`).checked = !!c.auto_restore;
  field(`${kind}_wol_mac`).value = c.wol_mac ?? '';
  field(`${kind}_wake_mode`).value = c.wake_mode ?? 'packet';
  field(`${kind}_wake_relay_id`).value = c.wake_relay_id != null ? String(c.wake_relay_id) : '';
  field(`${kind}_wol_broadcast`).value = c.wol_broadcast ?? '';
  field(`${kind}_restore_wait_seconds`).value = String(c.restore_wait_seconds ?? DEFAULT_RESTORE_WAIT);
  field(`${kind}_restore_action`).value = c.restore_action ?? 'none';
  field(`${kind}_restore_command`).value = c.restore_command ?? '';
  field(`${kind}_restore_url`).value = c.restore_url ?? '';
  field(`${kind}_restore_method`).value = c.restore_method ?? 'POST';
  field(`${kind}_restore_body`).value = c.restore_body ?? '';
  field(`${kind}_restore_auth_scheme`).value = c.restore_auth_scheme ?? 'none';
  field(`${kind}_restore_header_name`).value = c.restore_header_name ?? '';
  field(`${kind}_restore_username`).value = c.restore_username ?? '';
}

function collectConfig(kind) {
  switch (kind) {
    case 'ssh': return {
      host: field('ssh_host').value,
      port: Number(field('ssh_port').value) || 22,
      username: field('ssh_username').value,
      auth_method: field('ssh_auth_method').value,
      command: field('ssh_command').value,
      ...collectRestore('ssh')
    };
    case 'winrm': return {
      host: field('winrm_host').value,
      port: Number(field('winrm_port').value) || 5985,
      domain: field('winrm_domain').value,
      username: field('winrm_username').value,
      command: field('winrm_command').value,
      ...collectRestore('winrm')
    };
    case 'k8s': return {
      api_url: field('k8s_api_url').value,
      auth_method: field('k8s_auth_method').value,
      action: field('k8s_action').value,
      command_method: field('k8s_command_method').value,
      command_path: field('k8s_command_path').value,
      command_body: field('k8s_command_body').value,
      auto_restore: field('k8s_auto_restore').checked,
      restore_wait_seconds: Number(field('k8s_restore_wait_seconds').value) || 0,
      restore_uncordon: field('k8s_restore_uncordon').checked,
      restore_restart_deployments: field('k8s_restore_restart_deployments').checked,
      restore_method: field('k8s_restore_method').value,
      restore_path: field('k8s_restore_path').value,
      restore_body: field('k8s_restore_body').value
    };
    case 'http': return {
      url: field('http_url').value,
      method: field('http_method').value,
      auth_scheme: field('http_auth_scheme').value,
      header_name: field('http_header_name').value,
      username: field('http_username').value,
      body: field('http_body').value,
      login_url: field('http_login_url').value,
      login_method: field('http_login_method').value,
      login_auth: field('http_login_auth').value,
      login_content_type: field('http_login_content_type').value,
      login_body: field('http_login_body').value,
      login_username: field('http_login_username').value,
      token_source: field('http_token_source').value,
      token_json_path: field('http_token_json_path').value,
      token_response_header: field('http_token_response_header').value,
      token_cookie: field('http_token_cookie').value,
      token_header: field('http_token_header').value,
      session_cookie_name: field('http_session_cookie_name').value,
      session_cookie_json_path: field('http_session_cookie_json_path').value,
      send_cookies: field('http_send_cookies').checked,
      insecure_tls: field('http_insecure_tls').checked,
      ca_cert: field('http_ca_cert').value,
      auto_restore: field('http_auto_restore').checked,
      restore_wait_seconds: Number(field('http_restore_wait_seconds').value) || 0,
      restore_url: field('http_restore_url').value,
      restore_method: field('http_restore_method').value,
      restore_body: field('http_restore_body').value
    };
  }
}

function collectSecrets(kind) {
  const secrets = {};
  for (const [secretName, inputName] of Object.entries(SECRET_INPUTS[kind])) {
    const v = field(inputName).value;
    if (clearedSecrets.has(secretName)) secrets[secretName] = null;
    else if (v) secrets[secretName] = v;
  }
  return secrets;
}

function resetTargetForm() {
  editingTargetId = null;
  $form.reset();
  $formTitle.textContent = 'Add action target';
  $formSubmit.textContent = 'Add target';
  $formCancel.style.display = 'none';
  $formReset.style.display = '';
  $formError.textContent = '';
  $formSaveNote.textContent = '';
  targetDirty.markClean();
  renderSecretStates('none', []);
  syncKindSections();
}

function fillTargetForm(t) {
  resetTargetForm();
  editingTargetId = t.id;
  field('name').value = t.name;
  $kind.value = t.kind;
  field('enabled').checked = !!t.enabled;

  const c = t.config;
  switch (t.kind) {
    case 'ssh':
      field('ssh_host').value = c.host ?? '';
      field('ssh_port').value = String(c.port ?? 22);
      field('ssh_username').value = c.username ?? '';
      field('ssh_auth_method').value = c.auth_method ?? 'password';
      field('ssh_command').value = c.command ?? '';
      fillRestore('ssh', c);
      break;
    case 'winrm':
      field('winrm_host').value = c.host ?? '';
      field('winrm_port').value = String(c.port ?? 5985);
      field('winrm_domain').value = c.domain ?? '';
      field('winrm_username').value = c.username ?? '';
      field('winrm_command').value = c.command ?? '';
      fillRestore('winrm', c);
      break;
    case 'k8s':
      field('k8s_api_url').value = c.api_url ?? '';
      field('k8s_auth_method').value = c.auth_method ?? 'token';
      field('k8s_action').value = c.action ?? 'drain';
      field('k8s_command_method').value = c.command_method ?? 'PATCH';
      field('k8s_command_path').value = c.command_path ?? '';
      field('k8s_command_body').value = c.command_body ?? '';
      field('k8s_auto_restore').checked = !!c.auto_restore;
      field('k8s_restore_wait_seconds').value = String(c.restore_wait_seconds ?? DEFAULT_RESTORE_WAIT);
      field('k8s_restore_uncordon').checked = !!c.restore_uncordon;
      field('k8s_restore_restart_deployments').checked = !!c.restore_restart_deployments;
      field('k8s_restore_method').value = c.restore_method ?? 'PATCH';
      field('k8s_restore_path').value = c.restore_path ?? '';
      field('k8s_restore_body').value = c.restore_body ?? '';
      break;
    case 'http':
      field('http_url').value = c.url ?? '';
      field('http_method').value = c.method ?? 'POST';
      field('http_auth_scheme').value = c.auth_scheme ?? 'none';
      field('http_header_name').value = c.header_name ?? '';
      field('http_username').value = c.username ?? '';
      field('http_body').value = c.body ?? '';
      field('http_login_url').value = c.login_url ?? '';
      field('http_login_method').value = c.login_method ?? 'POST';
      field('http_login_auth').value = c.login_auth ?? 'body';
      field('http_login_content_type').value = c.login_content_type ?? 'json';
      field('http_login_body').value = c.login_body ?? '';
      field('http_login_username').value = c.login_username ?? '';
      field('http_token_source').value = c.token_source ?? 'json';
      field('http_token_json_path').value = c.token_json_path ?? '';
      field('http_token_response_header').value = c.token_response_header ?? '';
      field('http_token_cookie').value = c.token_cookie ?? '';
      field('http_token_header').value = c.token_header ?? '';
      field('http_session_cookie_name').value = c.session_cookie_name ?? '';
      field('http_session_cookie_json_path').value = c.session_cookie_json_path ?? '';
      // Ticked by default for a new target, so an existing one that has never
      // been saved with the field must fall back to on, not off.
      field('http_send_cookies').checked = c.send_cookies ?? true;
      field('http_insecure_tls').checked = !!c.insecure_tls;
      field('http_ca_cert').value = c.ca_cert ?? '';
      field('http_auto_restore').checked = !!c.auto_restore;
      field('http_restore_wait_seconds').value = String(c.restore_wait_seconds ?? DEFAULT_RESTORE_WAIT);
      field('http_restore_url').value = c.restore_url ?? '';
      field('http_restore_method').value = c.restore_method ?? 'POST';
      field('http_restore_body').value = c.restore_body ?? '';
      break;
  }

  renderSecretStates(t.kind, t.secret_fields);
  syncKindSections();
  $formTitle.textContent = `Edit target: ${t.name}`;
  $formSubmit.textContent = 'Save changes';
  $formCancel.style.display = '';
  $formReset.style.display = 'none';
  targetFormSection.expand();
  igroupFormSection.collapse(); // one edit form open at a time
  $form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$formCancel.addEventListener('click', (e) => {
  e.preventDefault();
  resetTargetForm();
});

$formReset.addEventListener('click', () => resetTargetForm());

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const kind = $kind.value;
    const input = {
      name: field('name').value,
      kind,
      config: collectConfig(kind),
      secrets: collectSecrets(kind),
      enabled: field('enabled').checked
    };
    const wasEditing = editingTargetId != null;
    try {
      const saved = wasEditing ? await updateActionTarget(editingTargetId, input) : await createActionTarget(input);
      $formError.textContent = '';
      await refreshAll();
      if (wasEditing) {
        fillTargetForm(targetById(saved.id) ?? saved);
        $formSaveNote.textContent = 'Saved ✓';
      } else {
        resetTargetForm();
      }
    } catch (err) {
      $formError.textContent = err.message;
    }
  })();
});

$formTest.addEventListener('click', () => {
  void (async () => {
    const kind = $kind.value;
    $formTestResult.className = 'note';
    // A login-scheme http target has a safe test — the login itself. Every other
    // http target's test IS its real request, so say so before it goes.
    $formTestResult.textContent = kind !== 'http' ? 'Testing…'
      : $httpScheme.value === 'login' ? 'Logging in…' : 'Sending test request…';
    $formError.textContent = '';
    try {
      const result = await testActionTarget({
        id: editingTargetId ?? undefined,
        kind,
        config: collectConfig(kind),
        secrets: collectSecrets(kind)
      });
      $formTestResult.className = result.ok ? 'note' : 'error';
      $formTestResult.textContent = `${result.ok ? '✓' : '✕'} ${result.message}`;
    } catch (err) {
      $formTestResult.className = 'error';
      $formTestResult.textContent = err.message;
    }
  })();
});

function targetConnection(t) {
  const c = t.config;
  switch (t.kind) {
    case 'ssh': return `${c.username}@${c.host}:${c.port}`;
    case 'winrm': return `${c.domain ? c.domain + '\\' : ''}${c.username}@${c.host}:${c.port}`;
    case 'k8s': return c.api_url;
    case 'http': return c.url;
    default: return '';
  }
}

function targetAction(t) {
  const c = t.config;
  switch (t.kind) {
    case 'ssh': return c.command || '—';
    case 'winrm': return c.command || '—';
    case 'k8s': return c.action === 'custom' && c.command_path
      ? `${c.command_method ?? 'PATCH'} ${c.command_path}`
      : K8S_ACTION_LABELS[c.action] ?? c.action ?? '—';
    case 'http': return `send ${c.method ?? 'POST'} request`;
    default: return '—';
  }
}

/** Live connectivity dot: rechecked server-side about once a minute (see server/targetHealth.js). */
function targetStatusPill(t) {
  if (!t.enabled) {
    return el('span', { class: 'pill disabled' }, el('span', { class: 'dot' }), 'DISABLED');
  }
  if (!t.health) {
    return el('span', { class: 'pill unknown' }, el('span', { class: 'dot' }), 'PENDING');
  }
  const title = `${fmtDateTime(t.health.checkedAt)} — ${t.health.message}`;
  return t.health.ok
    ? el('span', { class: 'pill up', title }, el('span', { class: 'dot' }), 'UP')
    : el('span', { class: 'pill down', title }, el('span', { class: 'dot' }), 'DOWN');
}

/** Last manual Test/Run/Restore (or an automatic shutdown-triggered run) — independent of the
 *  live connectivity dot above, so it still updates for a paused target. */
function targetActivityText(t) {
  if (!t.last_activity) return 'never';
  const labels = { test: 'test', run: 'run', restore: 'restore' };
  return `${fmtDateTime(t.last_activity.ts)} (${labels[t.last_activity.trigger] ?? t.last_activity.trigger})`;
}

/**
 * The target's restore sequence spelled out, one sentence per step — shown in
 * the Restore button's tooltip and in its confirm dialog, which describe the
 * same thing. Each kind builds it from its own config: ssh/winrm from
 * wake -> wait -> final step, k8s and http from theirs.
 */
function restoreSteps(t) {
  if (t.kind === 'k8s') return k8sRestoreSteps(t.config);
  if (t.kind === 'http') return httpRestoreSteps(t.config);
  if (!RESTORE_SEQUENCE_KINDS.includes(t.kind)) return [];
  const c = t.config;
  const proto = PROTO_LABELS[t.kind];
  const steps = [];
  if (c.wol_mac) {
    const relay = relays.find((r) => r.id === c.wake_relay_id);
    steps.push(c.wake_mode === 'relay'
      ? `1. Ask relay "${relay?.name ?? `#${c.wake_relay_id}`}" to wake ${c.wol_mac}.`
      : `1. Wake ${c.wol_mac} with a magic packet to ${c.wol_broadcast || 'every attached network'}.`);
  }
  steps.push(`${steps.length + 1}. Wait up to ${c.restore_wait_seconds ?? DEFAULT_RESTORE_WAIT}s for ${proto} to answer.`);
  if (c.restore_action === 'command') steps.push(`${steps.length + 1}. Then run over ${proto}: ${c.restore_command}`);
  else if (c.restore_action === 'http') steps.push(`${steps.length + 1}. Then send ${c.restore_method ?? 'POST'} ${c.restore_url}`);
  return steps;
}

/** http's restore: the undo request, preceded by a wait for the login to answer
 *  when the target has one to wait on. */
function httpRestoreSteps(c) {
  const steps = [];
  if (c.auth_scheme === 'login' && (c.restore_wait_seconds ?? DEFAULT_RESTORE_WAIT) > 0) {
    steps.push(`1. Wait up to ${c.restore_wait_seconds ?? DEFAULT_RESTORE_WAIT}s for ${c.login_url} to accept the login.`);
  }
  steps.push(`${steps.length + 1}. Send ${c.restore_method ?? 'POST'} ${c.restore_url}`);
  return steps;
}

function k8sRestoreSteps(c) {
  const steps = [`1. Wait up to ${c.restore_wait_seconds ?? DEFAULT_RESTORE_WAIT}s for the API server to answer.`];
  if (c.action !== 'custom' || c.restore_uncordon) steps.push(`${steps.length + 1}. Uncordon every node.`);
  if (c.restore_path) steps.push(`${steps.length + 1}. Then send ${c.restore_method ?? 'PATCH'} ${c.restore_path}`);
  if (c.restore_restart_deployments) steps.push(`${steps.length + 1}. Restart every Deployment outside kube-system.`);
  return steps;
}

/** Whether the target has enough configured for Restore to do anything. */
function hasRestore(t) {
  const c = t.config;
  // A drained cluster always has an undo (uncordon); a custom command has one
  // only if its owner asked for something — the reversing request, or either of
  // the cluster-wide steps.
  if (t.kind === 'k8s') {
    return c.action !== 'custom' || !!(c.restore_uncordon || c.restore_path || c.restore_restart_deployments);
  }
  if (t.kind === 'http') return !!c.restore_url;
  return !!(c.wol_mac
    || (c.restore_action === 'command' && c.restore_command)
    || (c.restore_action === 'http' && c.restore_url));
}

function renderTargetTable() {
  clear($targetTable);
  if (targets.length === 0) {
    $targetTable.append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, 'No action targets yet'),
      el('div', {}, 'Add the machines and services to act on using the form below.')));
    return;
  }

  const tbody = el('tbody', {});
  for (const t of targets) {
    const editBtn = el('button', { class: 'btn ghost small' }, 'Edit');
    editBtn.addEventListener('click', () => fillTargetForm(t));
    const delBtn = el('button', { class: 'btn danger-ghost small' }, 'Delete');
    delBtn.addEventListener('click', () => {
      void (async () => {
        const ok = await confirmDialog({
          title: 'Delete action target?',
          body: `"${t.name}" and its stored credentials will be permanently deleted. Any action group step that runs it will stop working.`,
          confirmText: 'Delete target',
          danger: true
        });
        if (!ok) return;
        await deleteActionTarget(t.id);
        if (editingTargetId === t.id) resetTargetForm();
        await refreshAll();
      })();
    });

    const runBtn = el('button', { class: 'btn danger-soft small' }, 'Run');
    runBtn.addEventListener('click', () => {
      void (async () => {
        const whatRuns = t.kind === 'http'
          ? `This sends the real request configured for "${t.name}" immediately.`
          : `This runs the real command configured for "${t.name}" immediately.`;
        const ok = await confirmDialog({
          title: 'Run this action now?',
          body: [whatRuns, 'This runs the action selected and CANNOT be undone!'],
          confirmText: 'Run now',
          danger: true
        });
        if (!ok) return;
        runBtn.disabled = true;
        try {
          const result = await runActionTarget(t.id);
          await alertDialog({ title: result.ok ? 'Action completed' : 'Action failed', body: result.message });
        } catch (err) {
          await alertDialog({ title: 'Action failed', body: err.message });
        } finally {
          await refreshAll();
        }
      })();
    });

    const restoreBtn = el('button', { class: 'btn ghost small' }, 'Restore');
    if (!hasRestore(t)) {
      restoreBtn.disabled = true;
      restoreBtn.title = 'No restore configured for this target — set one up in the edit form';
    } else {
      const steps = restoreSteps(t);
      restoreBtn.title = [
        t.config.auto_restore ? 'Auto-restore is ON for this target.' : null,
        ...steps
      ].filter(Boolean).join('\n');
      restoreBtn.addEventListener('click', () => {
        void (async () => {
          const ok = await confirmDialog({
            title: 'Run restore now?',
            body: [`This runs the restore sequence for "${t.name}" immediately:`, ...steps],
            confirmText: 'Restore now'
          });
          if (!ok) return;
          restoreBtn.disabled = true;
          try {
            const result = await restoreActionTarget(t.id);
            // The ssh/winrm sequence waits for the host to boot, so the server
            // answers as soon as it starts — the outcome shows up in Last activity.
            await alertDialog({
              title: result.started ? 'Restore started' : result.ok ? 'Restore completed' : 'Restore failed',
              body: result.message
            });
          } catch (err) {
            await alertDialog({ title: 'Restore failed', body: err.message });
          } finally {
            await refreshAll();
          }
        })();
      });
    }

    const credentials = t.secret_fields.length ? `🔒 ${t.secret_fields.join(', ')}` : '—';

    tbody.append(el('tr', {},
      el('td', {}, targetStatusPill(t)),
      el('td', { class: 'truncate', title: t.name }, el('strong', {}, t.name)),
      el('td', { class: 'truncate' }, KIND_LABELS[t.kind] ?? t.kind),
      el('td', { class: 'target-cell', title: targetConnection(t) }, targetConnection(t)),
      el('td', { class: 'target-cell', title: targetAction(t) }, targetAction(t)),
      el('td', { class: 'truncate', title: credentials }, credentials),
      el('td', { class: 'truncate' }, targetActivityText(t)),
      el('td', { class: 'actions-cell' }, editBtn, delBtn, runBtn, restoreBtn)
    ));
  }

  const table = el('table', { class: 'endpoints target-table' });
  table.append(
    el('colgroup', {},
      el('col', { style: 'width:9%' }), el('col', { style: 'width:15%' }), el('col', { style: 'width:8%' }),
      el('col', { style: 'width:15%' }), el('col', { style: 'width:15%' }), el('col', { style: 'width:11%' }),
      el('col', { style: 'width:11%' }), el('col', { style: 'width:16%' })),
    el('thead', {}, el('tr', {},
      el('th', {}, 'Status'), el('th', {}, 'Name'), el('th', {}, 'Type'), el('th', {}, 'Connection'),
      el('th', {}, 'Runs on trigger'), el('th', {}, 'Credentials'), el('th', {}, 'Last activity'), el('th', {}, ''))),
    tbody
  );
  $targetTable.append(table);
}

// ---------- action groups (ordered stages of parallel steps) ----------

const $igForm = document.getElementById('igroup-form');
const $igFormTitle = document.getElementById('igroup-form-title');
const $igError = document.getElementById('igroup-error');
const $igSubmit = document.getElementById('igroup-submit');
const $igCancel = document.getElementById('igroup-cancel');
const $igReset = document.getElementById('igroup-reset');
const $igSaveNote = document.getElementById('igroup-save-note');
const $igTable = document.getElementById('igroup-table');
const $stageList = document.getElementById('stage-list');
const $stageAddBtn = document.getElementById('stage-add-btn');
const $igFlatlineGroupChecks = document.getElementById('ig-flatline-group-checks');
const igroupFormSection = initCollapsible('actions:igroup-form',
  document.getElementById('igroup-form-header'), document.getElementById('igroup-form-body'));
const igDirty = initDirtyNote($igForm, document.getElementById('igroup-dirty'), $igSaveNote);

/** The gap held before every stage but the first — server default, mirrored here. */
const DEFAULT_STAGE_WAIT = 5;

let editingIgId = null;
/**
 * Ordered stages being edited:
 * [{ pass_rule, on_failure, wait_seconds, steps: [...] }], where a step is
 * either { target_id, timeout_seconds } or a wait: { wait_seconds }.
 */
let stages = [];

const isWaitStep = (step) => step.target_id == null;

/**
 * The longest a stage can take. Its wait steps split it into batches that run
 * one after another, so that is every wait plus, per batch, its slowest target.
 */
function stageWorstCase(stage) {
  let total = 0;
  let batch = 0;
  for (const step of stage.steps) {
    if (isWaitStep(step)) { total += batch + step.wait_seconds; batch = 0; }
    else batch = Math.max(batch, step.timeout_seconds);
  }
  return total + batch;
}

/** target_id -> [1-based stage numbers it appears in]. A target may be reused
 *  across stages, so this drives the "Appears in Stage …" indicator. */
function targetStageMap() {
  const map = new Map();
  stages.forEach((st, si) => {
    for (const s of st.steps) {
      if (isWaitStep(s)) continue;
      const arr = map.get(s.target_id) ?? [];
      arr.push(si + 1);
      map.set(s.target_id, arr);
    }
  });
  return map;
}

function renderStages() {
  clear($stageList);
  if (stages.length === 0) {
    $stageList.append(el('div', { class: 'hint-row', style: 'margin:6px 0' },
      'No stages yet — add one, then add targets to it. Stages run top to bottom.'));
  }
  const stageMap = targetStageMap();
  stages.forEach((stage, si) => {
    // The gap belongs between two cards, so the first stage never shows one —
    // a triggered run starts acting straight away.
    if (si > 0) $stageList.append(renderStageWait(stage, si));
    $stageList.append(renderStage(stage, si, stageMap));
  });
  $stageAddBtn.disabled = targets.length === 0;
}

/** The pause held between two stages: editable, 0 for none. */
function renderStageWait(stage, si) {
  const input = el('input', {
    type: 'number', min: '0', max: '3600', value: String(stage.wait_seconds),
    class: 'step-timeout',
    title: 'How long Flatline holds before starting this stage. 0 runs it as soon as the stage above finishes.'
  });
  input.addEventListener('change', () => {
    stage.wait_seconds = Math.min(3600, Math.max(0, Number(input.value) || 0));
    renderStages();
  });
  return el('div', { class: 'stage-wait' },
    el('span', { class: 'hint' }, '⏱ wait'), input,
    el('span', { class: 'hint' }, stage.wait_seconds === 0
      ? `s — no pause before Stage ${si + 1}`
      : `s before Stage ${si + 1}`));
}

function renderStage(stage, si, stageMap) {
  const up = el('button', { type: 'button', class: 'btn ghost small', title: 'Move stage up' }, '↑');
  up.disabled = si === 0;
  up.addEventListener('click', () => {
    [stages[si - 1], stages[si]] = [stages[si], stages[si - 1]];
    renderStages();
  });
  const down = el('button', { type: 'button', class: 'btn ghost small', title: 'Move stage down' }, '↓');
  down.disabled = si === stages.length - 1;
  down.addEventListener('click', () => {
    [stages[si], stages[si + 1]] = [stages[si + 1], stages[si]];
    renderStages();
  });
  const removeStage = el('button', { type: 'button', class: 'btn danger-ghost small', title: 'Remove stage' }, '✕');
  removeStage.addEventListener('click', () => {
    stages.splice(si, 1);
    renderStages();
  });

  const worstCase = stageWorstCase(stage);
  const timingNote = el('span', { class: 'hint' }, worstCase ? ` · takes up to ${worstCase}s` : '');

  const stepList = el('div', { class: 'step-list' });
  if (stage.steps.length === 0) {
    stepList.append(el('div', { class: 'hint-row', style: 'margin:4px 0' }, 'No targets yet — add one below.'));
  }
  stage.steps.forEach((step, pi) => stepList.append(isWaitStep(step)
    ? renderWaitStep(stage, step, pi)
    : renderStageStep(stage, step, pi, stageMap)));

  // Add-target row: any target not already in THIS stage (reuse across stages is allowed).
  const inThisStage = new Set(stage.steps.map((s) => s.target_id));
  const available = targets.filter((t) => !inThisStage.has(t.id));
  const select = el('select', {});
  if (available.length === 0) {
    select.append(el('option', { value: '' },
      targets.length === 0 ? 'no targets defined yet' : 'all targets already in this stage'));
    select.disabled = true;
  } else {
    for (const t of available) {
      select.append(el('option', { value: String(t.id) }, `${t.name} (${KIND_LABELS[t.kind] ?? t.kind})`));
    }
  }
  const addBtn = el('button', { type: 'button', class: 'btn ghost small' }, '+ Add target');
  addBtn.disabled = available.length === 0;
  addBtn.addEventListener('click', () => {
    const id = Number(select.value);
    if (!id) return;
    stage.steps.push({ target_id: id, timeout_seconds: 60 });
    renderStages();
  });

  const addWaitBtn = el('button', { type: 'button', class: 'btn ghost small',
    title: 'Split this stage — the steps below the wait start only once it is up' },
    '+ Add wait');
  addWaitBtn.addEventListener('click', () => {
    stage.steps.push({ wait_seconds: DEFAULT_STAGE_WAIT });
    renderStages();
  });

  return el('div', { class: 'stage-card' },
    el('div', { class: 'stage-head' },
      el('span', { class: 'stage-title' }, `Stage ${si + 1}`, timingNote),
      el('span', { class: 'stage-btns' }, up, down, removeStage)),
    stepList,
    el('div', { class: 'step-add' }, select, addBtn, addWaitBtn),
    renderStageFailure(stage)
  );
}

/** Move buttons for a step within its stage, matching the stage cards' own ↑ ↓.
 *  Lets a wait be dropped in beside the targets it belongs with, without
 *  removing and re-adding everything below it. */
function stepMoveButtons(stage, pi) {
  const up = el('button', { type: 'button', class: 'btn ghost small', title: 'Move up within this stage' }, '↑');
  up.disabled = pi === 0;
  up.addEventListener('click', () => {
    [stage.steps[pi - 1], stage.steps[pi]] = [stage.steps[pi], stage.steps[pi - 1]];
    renderStages();
  });

  const down = el('button', { type: 'button', class: 'btn ghost small', title: 'Move down within this stage' }, '↓');
  down.disabled = pi === stage.steps.length - 1;
  down.addEventListener('click', () => {
    [stage.steps[pi], stage.steps[pi + 1]] = [stage.steps[pi + 1], stage.steps[pi]];
    renderStages();
  });

  return [up, down];
}

/** A wait step: no target, no outcome — it splits the stage at its place in the
 *  order, holding everything below it until the time is up. */
function renderWaitStep(stage, step, pi) {
  const gates = pi < stage.steps.length - 1;
  const seconds = el('input', {
    type: 'number', min: '1', max: '3600', value: String(step.wait_seconds),
    class: 'step-timeout',
    title: gates
      ? 'How long to hold before the steps below this one start. Whatever is above it has already run.'
      : 'How long to hold the stage open after its targets are done, before the next stage.'
  });
  seconds.addEventListener('change', () => {
    step.wait_seconds = Math.min(3600, Math.max(1, Number(seconds.value) || DEFAULT_STAGE_WAIT));
    renderStages(); // the stage's "takes up to Ns" note follows this value
  });

  const remove = el('button', { type: 'button', class: 'btn danger-ghost small', title: 'Remove wait' }, '✕');
  remove.addEventListener('click', () => {
    stage.steps.splice(pi, 1);
    renderStages();
  });

  return el('div', { class: 'step-row wait' },
    el('span', { class: 'step-name' }, '⏱ Wait',
      el('span', { class: 'hint' }, gates
        ? ' (everything below starts after this)'
        : ' (holds the stage open at the end)')),
    el('span', { class: 'step-timeout-wrap' },
      el('span', { class: 'hint' }, 'for'), seconds, el('span', { class: 'hint' }, 's')),
    el('span', { class: 'step-btns' }, ...stepMoveButtons(stage, pi), remove)
  );
}

function renderStageStep(stage, step, pi, stageMap) {
  const t = targetById(step.target_id);
  const appearsIn = stageMap.get(step.target_id) ?? [];

  const timeout = el('input', {
    type: 'number', min: '5', max: '3600', value: String(step.timeout_seconds),
    class: 'step-timeout',
    title: 'How long to wait for this target to answer before the step counts as failed. '
      + 'Not a delay — a target that finishes sooner moves the stage along sooner.'
  });
  timeout.addEventListener('change', () => {
    step.timeout_seconds = Math.min(3600, Math.max(5, Number(timeout.value) || 60));
    renderStages(); // the stage's "takes up to Ns" note follows this value
  });

  const remove = el('button', { type: 'button', class: 'btn danger-ghost small', title: 'Remove target' }, '✕');
  remove.addEventListener('click', () => {
    stage.steps.splice(pi, 1);
    renderStages();
  });

  return el('div', { class: 'step-row' },
    el('span', { class: 'step-name' },
      t ? t.name : `(deleted target ${step.target_id})`,
      t ? el('span', { class: 'hint' }, ` (${KIND_LABELS[t.kind] ?? t.kind})`) : null,
      appearsIn.length > 1
        ? el('span', { class: 'step-reuse', title: 'This target runs in more than one stage' },
            ` (Appears in Stage ${appearsIn.join(', ')})`)
        : null),
    el('span', { class: 'step-timeout-wrap' },
      el('span', { class: 'hint' }, 'give up after'), timeout, el('span', { class: 'hint' }, 's')),
    el('span', { class: 'step-btns' }, ...stepMoveButtons(stage, pi), remove)
  );
}

/** The stage's independent failure decision: pass rule (multi-target only) + on_failure override. */
function renderStageFailure(stage) {
  const wrap = el('div', { class: 'stage-failure' });

  if (stage.steps.length > 1) {
    const passSel = el('select', { class: 'stage-select' });
    passSel.append(
      el('option', { value: 'any' }, 'any target fails'),
      el('option', { value: 'all' }, 'all targets fail'));
    passSel.value = stage.pass_rule;
    passSel.addEventListener('change', () => { stage.pass_rule = passSel.value; });
    wrap.append(el('span', { class: 'stage-policy' }, el('span', { class: 'hint' }, 'Counts as failed when '), passSel));
  }

  const failSel = el('select', { class: 'stage-select' });
  failSel.append(
    el('option', { value: '' }, 'use group default'),
    el('option', { value: 'continue' }, 'continue'),
    el('option', { value: 'stop' }, 'stop remaining stages'));
  failSel.value = stage.on_failure ?? '';
  failSel.addEventListener('change', () => { stage.on_failure = failSel.value || null; });
  wrap.append(el('span', { class: 'stage-policy' }, el('span', { class: 'hint' }, 'If failed '), failSel));

  return wrap;
}

function renderIgFlatlineGroupChecks(selectedIds = []) {
  clear($igFlatlineGroupChecks);
  if (flatlineGroups.length === 0) {
    $igFlatlineGroupChecks.append(el('span', { class: 'hint-row' },
      'No Flatline groups yet — create one on the ',
      el('a', { href: '/flatline' }, 'Flatline page'),
      '.'));
    return;
  }
  for (const fg of flatlineGroups) {
    const cb = el('input', { type: 'checkbox', value: String(fg.id) });
    cb.checked = selectedIds.includes(fg.id);
    cb.dataset.flatlineGroup = '1';
    $igFlatlineGroupChecks.append(el('label', { class: 'check' }, cb, el('span', {}, fg.name)));
  }
}

function selectedIgFlatlineGroupIds() {
  return [...$igFlatlineGroupChecks.querySelectorAll('input[data-flatline-group]')]
    .filter((cb) => cb.checked)
    .map((cb) => Number(cb.value));
}

$stageAddBtn.addEventListener('click', () => {
  stages.push({ pass_rule: 'any', on_failure: null, wait_seconds: DEFAULT_STAGE_WAIT, steps: [] });
  renderStages();
});

function resetIgForm() {
  editingIgId = null;
  stages = [];
  $igForm.reset();
  $igFormTitle.textContent = 'Add action group';
  $igSubmit.textContent = 'Add group';
  $igCancel.style.display = 'none';
  $igReset.style.display = '';
  $igError.textContent = '';
  $igSaveNote.textContent = '';
  renderStages();
  renderIgFlatlineGroupChecks();
}

function fillIgForm(g) {
  editingIgId = g.id;
  stages = g.stages.map((st) => ({
    pass_rule: st.pass_rule,
    on_failure: st.on_failure ?? null,
    wait_seconds: st.wait_seconds ?? DEFAULT_STAGE_WAIT,
    steps: st.steps.map((s) => ({ ...s }))
  }));
  $igForm.elements.namedItem('name').value = g.name;
  $igForm.elements.namedItem('on_failure').value = g.on_failure;
  $igForm.elements.namedItem('enabled').checked = !!g.enabled;
  renderStages();
  const assignedIds = flatlineGroups.filter((fg) => fg.action_group_ids.includes(g.id)).map((fg) => fg.id);
  renderIgFlatlineGroupChecks(assignedIds);
  $igFormTitle.textContent = `Edit group: ${g.name}`;
  $igSubmit.textContent = 'Save changes';
  $igCancel.style.display = '';
  $igReset.style.display = 'none';
  $igError.textContent = '';
  $igSaveNote.textContent = '';
  igDirty.markClean();
  igroupFormSection.expand();
  targetFormSection.collapse(); // one edit form open at a time
  $igForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$igCancel.addEventListener('click', (e) => {
  e.preventDefault();
  resetIgForm();
});

$igReset.addEventListener('click', () => resetIgForm());

/** Applies the checked Flatline groups for this action group by updating each
 *  affected Flatline group's own action_group_ids (the assignment is stored
 *  there) — adding/removing actionGroupId without disturbing anything else. */
async function applyFlatlineGroupAssignments(actionGroupId, desiredIds) {
  const current = flatlineGroups.filter((fg) => fg.action_group_ids.includes(actionGroupId));
  const currentIds = current.map((fg) => fg.id);
  const toAdd = desiredIds.filter((id) => !currentIds.includes(id));
  const toRemove = currentIds.filter((id) => !desiredIds.includes(id));

  for (const id of toAdd) {
    const fg = flatlineGroups.find((g) => g.id === id);
    await updateGroup(fg.id, { ...fg, action_group_ids: [...fg.action_group_ids, actionGroupId] });
  }
  for (const id of toRemove) {
    const fg = flatlineGroups.find((g) => g.id === id);
    await updateGroup(fg.id, { ...fg, action_group_ids: fg.action_group_ids.filter((x) => x !== actionGroupId) });
  }
}

$igForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const input = {
      name: $igForm.elements.namedItem('name').value,
      on_failure: $igForm.elements.namedItem('on_failure').value,
      enabled: $igForm.elements.namedItem('enabled').checked,
      stages: stages.filter((st) => st.steps.length > 0)
    };
    const wasEditing = editingIgId != null;
    try {
      const saved = wasEditing ? await updateActionGroup(editingIgId, input) : await createActionGroup(input);
      await applyFlatlineGroupAssignments(saved.id, selectedIgFlatlineGroupIds());
      $igError.textContent = '';
      await refreshAll();
      if (wasEditing) {
        fillIgForm(igroups.find((g) => g.id === saved.id) ?? saved);
        $igSaveNote.textContent = 'Saved ✓';
      } else {
        resetIgForm();
      }
    } catch (err) {
      $igError.textContent = err.message;
    }
  })();
});

/** One stage as text: "k8s + NAS, wait 10s, Windows" — batch, wait, batch. */
function stageStepText(stage) {
  const parts = [];
  let batch = [];
  for (const s of stage.steps) {
    if (s.target_id != null) {
      batch.push(targetById(s.target_id)?.name ?? '?');
      continue;
    }
    if (batch.length) parts.push(batch.join(' + '));
    batch = [];
    parts.push(`wait ${s.wait_seconds}s`);
  }
  if (batch.length) parts.push(batch.join(' + '));
  return parts.join(', ');
}

function renderIgTable() {
  clear($igTable);
  if (igroups.length === 0) {
    $igTable.append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, 'No action groups yet'),
      el('div', {}, 'Create an ordered sequence of targets using the form below.')));
    return;
  }

  const tbody = el('tbody', {});
  for (const g of igroups) {
    const editBtn = el('button', { class: 'btn ghost small' }, 'Edit');
    editBtn.addEventListener('click', () => fillIgForm(g));
    const delBtn = el('button', { class: 'btn danger-ghost small' }, 'Delete');
    delBtn.addEventListener('click', () => {
      void (async () => {
        const ok = await confirmDialog({
          title: 'Delete action group?',
          body: `"${g.name}" will be deleted. The action targets it uses are still available, only this sequence of steps is removed.`,
          confirmText: 'Delete group',
          danger: true
        });
        if (!ok) return;
        await deleteActionGroup(g.id);
        if (editingIgId === g.id) resetIgForm();
        await refreshAll();
      })();
    });

    // "+" joins what runs at once, "," what follows it once a wait is up, and
    // "→" separates stages, carrying the gap held between them.
    const stageText = g.stages.length
      ? g.stages.map((st, i) => {
          const gap = i === 0 ? '' : st.wait_seconds > 0 ? `  →(${st.wait_seconds}s)→  ` : '  →  ';
          return `${gap}${i + 1}. ${stageStepText(st)}`;
        }).join('')
      : '—';
    const hasOverride = g.stages.some((st) => st.on_failure);

    tbody.append(el('tr', {},
      el('td', {}, enabledPill(g.enabled)),
      el('td', {}, el('strong', {}, g.name)),
      el('td', { class: 'target-cell', title: stageText }, stageText),
      el('td', {},
        g.on_failure === 'stop' ? 'stop sequence' : 'continue',
        hasOverride ? el('span', { class: 'hint', title: 'Some stages override this' }, ' · overrides') : null),
      el('td', { class: 'mono' }, `${g.assigned_count} Flatline group(s)`),
      el('td', {}, el('span', { style: 'display:inline-flex;gap:6px' }, editBtn, delBtn))
    ));
  }

  const table = el('table', { class: 'endpoints' });
  table.append(
    el('thead', {}, el('tr', {},
      el('th', {}, 'Status'), el('th', {}, 'Group'), el('th', {}, 'Stages (in order)'), el('th', {}, 'On stage failure'),
      el('th', {}, 'Assigned to'), el('th', {}, ''))),
    tbody
  );
  $igTable.append(table);
}

// ---------- boot ----------

async function refreshAll() {
  [targets, igroups, flatlineGroups, relays] = await Promise.all([
    listActionTargets(), listActionGroups(), listGroups(), listRelays()
  ]);
  renderRelayOptions();
  renderTargetTable();
  renderIgTable();
  renderStages();
  // Keep the checklist valid without clobbering an in-progress edit.
  if (editingIgId == null) {
    renderIgFlatlineGroupChecks(selectedIgFlatlineGroupIds());
  } else {
    const assignedIds = flatlineGroups.filter((fg) => fg.action_group_ids.includes(editingIgId)).map((fg) => fg.id);
    renderIgFlatlineGroupChecks(assignedIds);
  }
}

resetTargetForm();
resetIgForm();
void refreshAll();
// Picks up the background connectivity dot (server rechecks targets ~every minute).
setInterval(() => void refreshAll(), 20_000);
