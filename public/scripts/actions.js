import {
  actionTargets, actionGroups, groups as flatlineGroupsApi, relays as relaysApi,
  runActionTarget, restoreActionTarget, getRestoreStatus
} from './api.js';
import {
  el, clear, fmtDateTime, enabledPill, initCollapsible, initDirtyNote, wireFileUpload,
  confirmDialog, alertDialog, initHelp, toggleByData
} from './dom.js';
import {
  initEntityForm, initSecretFields, renderTable, editDeleteButtons, actionsCell
} from './crud.js';
import { initHeaderAuth } from './header.js';
import { loadSnapshot, saveSnapshotOnExit } from './snapshot.js';
import { watchBanners } from './banners.js';
// Relative, not '/shared/…': public/ is served at / and shared/ at /shared/, so
// this resolves to /shared/net.js in the browser and to the file on disk under
// Node — which is what lets this module be imported by a test.
import { hostInNetwork } from '../../shared/net.js';
import { RESTORE_SECRET_FIELDS } from '../../shared/restoreSecrets.js';

initHeaderAuth();
initHelp();

let targets = [];
let igroups = [];
let flatlineGroups = [];
let relays = [];
let loaded = false; // true once the live lists have arrived at least once

const KIND_LABELS = { ssh: 'SSH', winrm: 'WinRM', k8s: 'Kubernetes', http: 'HTTP(S)' };
const K8S_ACTION_LABELS = { drain: 'drain all nodes', custom: 'custom request' };

// Maps a kind's secret field -> form input name, for the target's own connection.
const SECRET_INPUTS = {
  ssh:  { password: 'ssh_password', private_key: 'ssh_private_key', passphrase: 'ssh_passphrase',
          sudo_password: 'ssh_sudo_password' },
  winrm: { password: 'winrm_password' },
  k8s:  { token: 'k8s_token', kubeconfig: 'k8s_kubeconfig' },
  http: { token: 'http_token', password: 'http_password', login_password: 'http_login_password' }
};

// RESTORE_SECRET_FIELDS (imported above) is both restore steps' own credentials,
// used only where a step does not inherit the target's. One panel serves every
// kind, and each step's inputs are named for its own fields — no mapping through.

const PROTO_LABELS = { ssh: 'SSH', winrm: 'WinRM' };
const DEFAULT_RESTORE_WAIT = 300;
/**
 * The restore's two configurable steps, which are the same shape and so share
 * their wiring: `p` prefixes every field name, `id` every element id, and the
 * two data attributes tag the markup belonging to each.
 */
const RESTORE_STEPS = [
  { p: 'restore_', id: 'restore-', kindAttr: 'rk', authAttr: 'rauth' },
  { p: 'post_restore_', id: 'post-restore-', kindAttr: 'prk', authAttr: 'prauth' }
];
/** Verbs offered to a step's request, per method. Kubernetes takes PATCH; the
 *  HTTP kind does not. One select per step serves both, repopulated on change. */
const REQUEST_METHODS = {
  k8s: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  http: ['GET', 'POST', 'PUT', 'DELETE']
};
/** Which of a step's connection selects names its sub-auth, per method — the
 *  second axis the connection fields are shown on (see syncRestoreStep). WinRM
 *  is absent because it has only one way to sign in. */
const STEP_AUTH_FIELD = {
  ssh: 'auth_method',
  k8s: 'k8s_auth',
  http: 'auth_scheme'
};

function targetById(id) {
  return targets.find((t) => t.id === id);
}

// ---------- target form ----------

const $form = document.getElementById('target-form');
const $formError = document.getElementById('target-error');
const $formTest = document.getElementById('target-test');
const $formTestResult = document.getElementById('target-test-result');
const $formSaveNote = document.getElementById('target-save-note');
const $kind = document.getElementById('t-kind');
const $httpScheme = document.getElementById('http-auth-scheme');
const $targetTable = document.getElementById('target-table');
const $sshAuthMethod = $form.elements.namedItem('ssh_auth_method');
const $k8sAuthMethod = $form.elements.namedItem('k8s_auth_method');
const $k8sAction = $form.elements.namedItem('k8s_action');
const $restoreEnabled = $form.elements.namedItem('restore_enabled');
const $restoreSummary = document.getElementById('restore-summary');
const targetFormSection = initCollapsible('actions:target-form',
  document.getElementById('target-form-header'), document.getElementById('target-form-body'));
// The Restore panel is the longest part of the form and most targets never
// change it after setup, so it folds away on its own.
initCollapsible('actions:restore',
  document.getElementById('restore-header'), document.getElementById('restore-body'));
const targetDirty = initDirtyNote($form, document.getElementById('target-dirty'), $formSaveNote);
/** One Restore panel serves all four kinds, so its credentials sit outside every
 *  .kind-section — hence unsectionedIsGlobal. */
const targetSecrets = initSecretFields($form, {
  sectionAttr: 'kind',
  unsectionedIsGlobal: true,
  onDirty: () => targetDirty.markDirty()
});

function field(name) {
  return $form.elements.namedItem(name);
}

function syncKindSections() {
  toggleByData($form, 'kind', $kind.value);
  syncHttpAuthFields();
  syncSshAuthFields();
  syncK8sAuthFields();
  syncK8sActionFields();
  syncRestoreFields();
  $formTestResult.textContent = '';
}

/** The whole Restore panel: whether it is on at all, then each of its two
 *  configurable steps. */
function syncRestoreFields() {
  document.getElementById('restore-config').style.display = $restoreEnabled.checked ? '' : 'none';

  syncRestoreStep(RESTORE_STEPS[0]);
  const postKind = syncRestoreStep(RESTORE_STEPS[1]);

  // Left blank the port falls back to the method's default, so say which one
  // that would be rather than showing SSH's on a WinRM action.
  if (postKind === 'ssh' || postKind === 'winrm') {
    field('post_restore_port').placeholder = postKind === 'ssh' ? '22' : '5985';
  }

  toggleByData($form, 'wake-mode', field('wake_mode').value);
  renderRelayWarning();
  renderRestoreSummary();
}

/**
 * One restore step: which method it uses and — when it connects somewhere of its
 * own — that method's connection fields. Returns the chosen method.
 *
 * A field shows when the step's kind attribute names the chosen method and,
 * where present, its auth attribute names that method's current sub-auth (SSH's
 * password/key, the cluster's token/kubeconfig, HTTP's scheme). Everything
 * inside the step's connection block is additionally hidden while it inherits,
 * since then there is nothing of its own to fill in.
 */
function syncRestoreStep({ p, id, kindAttr, authAttr }) {
  const stepKind = field(`${p}kind`).value;

  // Inheriting means "the same machine, reached the same way", which only
  // exists when the method is the target's own kind. The choice is only hidden
  // while that does not hold, not reset — so switching away from a method and
  // back does not quietly turn "same as target" into "its own". The server drops
  // the flag for a method that cannot inherit anyway.
  const canInherit = stepKind === $kind.value;
  document.getElementById(`${id}inherit-field`).style.display = canInherit ? '' : 'none';
  const inherits = canInherit && field(`${p}inherit`).value === '1';

  document.getElementById(`${id}connection`).style.display =
    !inherits && stepKind !== 'wol' && stepKind !== 'none' ? '' : 'none';

  // Two axes here rather than one, so this stays a hand-rolled loop: a field
  // shows only when its method AND that method's sub-auth both match. A method
  // with no sub-auth to pick (WinRM) skips the second axis rather than failing
  // it, or its own fields would never show.
  const authName = STEP_AUTH_FIELD[stepKind];
  const auth = authName ? field(p + authName).value : null;
  for (const node of $form.querySelectorAll(`[data-${kindAttr}]`)) {
    const kindMatch = node.dataset[kindAttr].split(' ').includes(stepKind);
    const authMatch = node.dataset[authAttr] == null || !authName
      || node.dataset[authAttr].split(' ').includes(auth);
    node.style.display = kindMatch && authMatch ? '' : 'none';
  }

  renderRequestMethods(document.getElementById(`${id}request-method`), stepKind);
  return stepKind;
}

/** A step's request-method select is shared by its Kubernetes and HTTP methods,
 *  which do not accept the same verbs. Repopulated rather than duplicated, so
 *  there is only ever one such input per step. */
function renderRequestMethods(select, stepKind) {
  const methods = REQUEST_METHODS[stepKind];
  if (!methods) return;
  const chosen = select.value;
  clear(select);
  for (const m of methods) select.append(el('option', { value: m }, m));
  select.value = methods.includes(chosen) ? chosen : (stepKind === 'k8s' ? 'PATCH' : 'POST');
}

/** A folded panel still has to say whether a restore exists, and roughly what
 *  it does — it is the one part of the form that is off by default. */
function renderRestoreSummary() {
  if (!$restoreEnabled.checked) {
    $restoreSummary.textContent = 'off';
    return;
  }
  const restoreKind = field('restore_kind').value;
  const parts = [restoreKind === 'wol'
    ? (field('wol_mac').value.trim() ? 'wake' : 'no wake')
    : KIND_LABELS[restoreKind]];
  const postKind = field('post_restore_kind').value;
  if (postKind !== 'none') parts.push(`then ${KIND_LABELS[postKind]}`);
  if (field('auto_restore').checked) parts.push('auto');
  $restoreSummary.textContent = parts.join(' · ');
}

/** The address the woken machine is expected to answer on, for the relay check
 *  below. That is whatever the restore is about to connect to once the packet is
 *  out: the post-restore action's own host where it has one, otherwise the
 *  target's own address. */
function wakeHost() {
  const postKind = field('post_restore_kind').value;
  if (postKind === 'ssh' || postKind === 'winrm') {
    return postKind === $kind.value && field('post_restore_inherit').value === '1'
      ? field(`${$kind.value}_host`).value.trim()
      : field('post_restore_host').value.trim();
  }
  const kind = $kind.value;
  if (kind === 'ssh' || kind === 'winrm') return field(`${kind}_host`).value.trim();
  try {
    return new URL(kind === 'k8s' ? field('k8s_api_url').value : field('http_url').value).hostname;
  } catch {
    return '';
  }
}

/**
 * Warns when the chosen relay cannot reach the address the target answers on. A
 * magic packet sent to the wrong network fails silently — nothing ever answers
 * one — so this is the only point at which the mistake is visible.
 */
function renderRelayWarning() {
  const note = document.getElementById('relay-note');
  clear(note);
  note.className = 'hint-row';

  const relayId = field('wake_relay_id').value;
  if (field('wake_mode').value !== 'relay' || !relayId) return;

  const relay = relays.find((r) => String(r.id) === relayId);
  if (!relay) return;

  const host = wakeHost();
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

/** Fills the relay picker. Kept as its own pass so the relay list can refresh
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
  toggleByData($form, 'http', $httpScheme.value);
  syncHttpTokenFields();
}

/** Inside the login block, the one field that names where the token is — a path
 *  into the body, a response header, or a cookie. */
function syncHttpTokenFields() {
  toggleByData($form, 'token-source', field('http_token_source').value);
}

function syncSshAuthFields() {
  toggleByData($form, 'ssh-auth', $sshAuthMethod.value);
}

function syncK8sAuthFields() {
  toggleByData($form, 'k8s-auth', $k8sAuthMethod.value);
}

function syncK8sActionFields() {
  toggleByData($form, 'k8s-action', $k8sAction.value);
}

$kind.addEventListener('change', syncKindSections);
$httpScheme.addEventListener('change', syncHttpAuthFields);
$form.querySelector('[data-token-source-select]').addEventListener('change', syncHttpTokenFields);
$sshAuthMethod.addEventListener('change', syncSshAuthFields);
$k8sAuthMethod.addEventListener('change', syncK8sAuthFields);
$k8sAction.addEventListener('change', syncK8sActionFields);
// Everything the Restore panel's visibility depends on, in one pass.
for (const name of ['restore_enabled', 'auto_restore', 'wake_mode',
  'restore_kind', 'restore_inherit', 'restore_k8s_auth', 'restore_auth_scheme',
  'post_restore_kind', 'post_restore_inherit', 'post_restore_auth_method',
  'post_restore_k8s_auth', 'post_restore_auth_scheme']) {
  field(name).addEventListener('change', syncRestoreFields);
}
// The summary line and the relay-reach warning both follow typed text, not just
// the selects: the MAC decides whether a wake is part of the summary, and the
// warning compares the relay's network against whichever host the restore will
// connect to.
field('wol_mac').addEventListener('input', renderRestoreSummary);
field('wake_relay_id').addEventListener('change', renderRelayWarning);
for (const name of ['post_restore_host', 'ssh_host', 'winrm_host', 'k8s_api_url', 'http_url']) {
  field(name).addEventListener('input', renderRelayWarning);
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
wireFileUpload(
  document.getElementById('restore-kubeconfig-upload-btn'),
  document.getElementById('restore-kubeconfig-upload'),
  $form.elements.namedItem('restore_kubeconfig')
);
wireFileUpload(
  document.getElementById('post-restore-key-upload-btn'),
  document.getElementById('post-restore-key-upload'),
  $form.elements.namedItem('post_restore_private_key')
);
wireFileUpload(
  document.getElementById('post-restore-kubeconfig-upload-btn'),
  document.getElementById('post-restore-kubeconfig-upload'),
  $form.elements.namedItem('post_restore_kubeconfig')
);

/**
 * The Restore panel, which is the same for every kind of target. Everything is
 * sent whatever the two methods are; the server keeps what the chosen ones use
 * and drops the rest, so switching method twice cannot leave the blob carrying a
 * host or a URL that nothing reads.
 */
function collectRestore() {
  return {
    restore_enabled: $restoreEnabled.checked,
    auto_restore: field('auto_restore').checked,
    restore_wait_seconds: Number(field('restore_wait_seconds').value) || 0,

    // step 1 — the restore itself
    restore_kind: field('restore_kind').value,
    restore_inherit: field('restore_inherit').value === '1',
    wol_mac: field('wol_mac').value,
    wake_mode: field('wake_mode').value,
    wake_relay_id: Number(field('wake_relay_id').value) || null,
    wol_broadcast: field('wol_broadcast').value,
    restore_api_url: field('restore_api_url').value,
    restore_k8s_auth: field('restore_k8s_auth').value,
    restore_uncordon: field('restore_uncordon').checked,
    restore_restart_deployments: field('restore_restart_deployments').checked,
    restore_path: field('restore_path').value,
    restore_url: field('restore_url').value,
    restore_auth_scheme: field('restore_auth_scheme').value,
    restore_header_name: field('restore_header_name').value,
    restore_username: field('restore_username').value,
    restore_insecure_tls: field('restore_insecure_tls').checked,
    restore_ca_cert: field('restore_ca_cert').value,
    restore_method: field('restore_method').value,
    restore_body: field('restore_body').value,

    // step 3 — the optional post-restore action
    post_restore_kind: field('post_restore_kind').value,
    post_restore_inherit: field('post_restore_inherit').value === '1',
    post_restore_host: field('post_restore_host').value,
    post_restore_port: Number(field('post_restore_port').value) || null,
    post_restore_domain: field('post_restore_domain').value,
    post_restore_username: field('post_restore_username').value,
    post_restore_auth_method: field('post_restore_auth_method').value,
    post_restore_command: field('post_restore_command').value,
    post_restore_api_url: field('post_restore_api_url').value,
    post_restore_k8s_auth: field('post_restore_k8s_auth').value,
    post_restore_uncordon: field('post_restore_uncordon').checked,
    post_restore_restart_deployments: field('post_restore_restart_deployments').checked,
    post_restore_path: field('post_restore_path').value,
    post_restore_url: field('post_restore_url').value,
    post_restore_auth_scheme: field('post_restore_auth_scheme').value,
    post_restore_header_name: field('post_restore_header_name').value,
    post_restore_insecure_tls: field('post_restore_insecure_tls').checked,
    post_restore_ca_cert: field('post_restore_ca_cert').value,
    post_restore_method: field('post_restore_method').value,
    post_restore_body: field('post_restore_body').value
  };
}

function fillRestore(c) {
  $restoreEnabled.checked = !!c.restore_enabled;
  field('auto_restore').checked = !!c.auto_restore;
  field('restore_wait_seconds').value = String(c.restore_wait_seconds ?? DEFAULT_RESTORE_WAIT);

  field('restore_kind').value = c.restore_kind ?? 'wol';
  field('restore_inherit').value = c.restore_inherit ? '1' : '0';
  field('wol_mac').value = c.wol_mac ?? '';
  field('wake_mode').value = c.wake_mode ?? 'packet';
  field('wake_relay_id').value = c.wake_relay_id != null ? String(c.wake_relay_id) : '';
  field('wol_broadcast').value = c.wol_broadcast ?? '';
  field('restore_api_url').value = c.restore_api_url ?? '';
  field('restore_k8s_auth').value = c.restore_k8s_auth ?? 'token';
  // Both default on for a new target, so an existing one saved before the
  // field existed must fall back to off, not on.
  field('restore_uncordon').checked = !!c.restore_uncordon;
  field('restore_restart_deployments').checked = !!c.restore_restart_deployments;
  field('restore_path').value = c.restore_path ?? '';
  field('restore_url').value = c.restore_url ?? '';
  field('restore_auth_scheme').value = c.restore_auth_scheme ?? 'none';
  field('restore_header_name').value = c.restore_header_name ?? '';
  field('restore_username').value = c.restore_username ?? '';
  field('restore_insecure_tls').checked = !!c.restore_insecure_tls;
  field('restore_ca_cert').value = c.restore_ca_cert ?? '';

  field('post_restore_kind').value = c.post_restore_kind ?? 'none';
  field('post_restore_inherit').value = c.post_restore_inherit ? '1' : '0';
  field('post_restore_host').value = c.post_restore_host ?? '';
  field('post_restore_port').value = c.post_restore_port != null ? String(c.post_restore_port) : '';
  field('post_restore_domain').value = c.post_restore_domain ?? '';
  field('post_restore_username').value = c.post_restore_username ?? '';
  field('post_restore_auth_method').value = c.post_restore_auth_method ?? 'password';
  field('post_restore_command').value = c.post_restore_command ?? '';
  field('post_restore_api_url').value = c.post_restore_api_url ?? '';
  field('post_restore_k8s_auth').value = c.post_restore_k8s_auth ?? 'token';
  field('post_restore_uncordon').checked = !!c.post_restore_uncordon;
  field('post_restore_restart_deployments').checked = !!c.post_restore_restart_deployments;
  field('post_restore_path').value = c.post_restore_path ?? '';
  field('post_restore_url').value = c.post_restore_url ?? '';
  field('post_restore_auth_scheme').value = c.post_restore_auth_scheme ?? 'none';
  field('post_restore_header_name').value = c.post_restore_header_name ?? '';
  field('post_restore_insecure_tls').checked = !!c.post_restore_insecure_tls;
  field('post_restore_ca_cert').value = c.post_restore_ca_cert ?? '';

  // Each request-method select's options depend on its step's method, so
  // populate them before trying to select one.
  for (const { p, id } of RESTORE_STEPS) {
    const select = document.getElementById(`${id}request-method`);
    renderRequestMethods(select, c[`${p}kind`] ?? 'none');
    if (c[`${p}method`]) select.value = c[`${p}method`];
  }
  field('restore_body').value = c.restore_body ?? '';
  field('post_restore_body').value = c.post_restore_body ?? '';
}

/** The target's own connection and trigger action. The Restore panel is spread
 *  in on top of every kind, since it is the same for all of them. */
function collectConfig(kind) {
  const restore = collectRestore();
  switch (kind) {
    case 'ssh': return {
      host: field('ssh_host').value,
      port: Number(field('ssh_port').value) || 22,
      username: field('ssh_username').value,
      auth_method: field('ssh_auth_method').value,
      command: field('ssh_command').value,
      ...restore
    };
    case 'winrm': return {
      host: field('winrm_host').value,
      port: Number(field('winrm_port').value) || 5985,
      domain: field('winrm_domain').value,
      username: field('winrm_username').value,
      command: field('winrm_command').value,
      ...restore
    };
    case 'k8s': return {
      api_url: field('k8s_api_url').value,
      auth_method: field('k8s_auth_method').value,
      action: field('k8s_action').value,
      command_method: field('k8s_command_method').value,
      command_path: field('k8s_command_path').value,
      command_body: field('k8s_command_body').value,
      ...restore
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
      ...restore
    };
  }
}

/** The target's own credentials plus the restore's, if it has any. Both are
 *  sent whatever the restore method is; the server keeps only the fields that
 *  method actually connects with. The restore's inputs are named for the fields
 *  themselves, so they map to themselves. */
function targetSecretInputs(kind) {
  const inputs = { ...SECRET_INPUTS[kind] };
  for (const name of RESTORE_SECRET_FIELDS) inputs[name] = name;
  return inputs;
}

function fillTargetForm(t) {
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
      break;
    case 'winrm':
      field('winrm_host').value = c.host ?? '';
      field('winrm_port').value = String(c.port ?? 5985);
      field('winrm_domain').value = c.domain ?? '';
      field('winrm_username').value = c.username ?? '';
      field('winrm_command').value = c.command ?? '';
      break;
    case 'k8s':
      field('k8s_api_url').value = c.api_url ?? '';
      field('k8s_auth_method').value = c.auth_method ?? 'token';
      field('k8s_action').value = c.action ?? 'drain';
      field('k8s_command_method').value = c.command_method ?? 'PATCH';
      field('k8s_command_path').value = c.command_path ?? '';
      field('k8s_command_body').value = c.command_body ?? '';
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
      break;
  }
  fillRestore(c);

  targetSecrets.render(t.kind, t.secret_fields);
  syncKindSections();
}

const targetForm = initEntityForm({
  form: $form,
  els: {
    title: document.getElementById('target-form-title'),
    error: $formError,
    submit: document.getElementById('target-submit'),
    cancel: document.getElementById('target-cancel'),
    reset: document.getElementById('target-reset'),
    saveNote: $formSaveNote
  },
  section: targetFormSection,
  siblingSection: () => igroupFormSection,
  dirty: targetDirty,
  noun: 'action target',
  itemLabel: 'target',
  api: actionTargets,
  reset: () => {
    targetSecrets.render('none', []);
    syncKindSections();
  },
  fill: fillTargetForm,
  collect: () => {
    const kind = $kind.value;
    return {
      name: field('name').value,
      kind,
      config: collectConfig(kind),
      secrets: targetSecrets.collect(targetSecretInputs(kind)),
      enabled: field('enabled').checked
    };
  },
  findSaved: targetById,
  refresh: refreshAll
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
      const result = await actionTargets.test({
        id: targetForm.editingId ?? undefined,
        kind,
        config: collectConfig(kind),
        secrets: targetSecrets.collect(targetSecretInputs(kind))
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
 * The activity cell. A restore in flight replaces the last-activity line for as
 * long as it runs: it opens by waiting minutes for a host to boot, and a row
 * that showed only the previous run's timestamp gave no sign anything was
 * happening at all.
 */
function targetActivityCell(t) {
  const p = t.restore_progress;
  if (!p) return el('td', { class: 'truncate' }, targetActivityText(t));

  // Not truncated: the phase is the whole point of the cell while a restore is
  // running, and this column is too narrow to hold it on one line. It wraps
  // under the pill instead, and the row goes back to one line when it finishes.
  const elapsed = Math.max(0, Math.round((Date.now() - p.startedAt) / 1000));
  return el('td', { class: 'restoring-cell', title: `${p.phase} — ${elapsed}s elapsed` },
    el('div', { class: 'elapsed' },
      el('span', { class: 'pill working' }, el('span', { class: 'dot' }), 'restoring'),
      el('span', { class: 'time' }, fmtElapsed(elapsed))),
    el('div', { class: 'phase' }, p.phase));
}

/** Elapsed seconds as the shortest thing that reads right — a restore can run
 *  for minutes, and "312s" is harder to glance at than "5m 12s". */
function fmtElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * The target's restore spelled out, one sentence per step — shown in the Restore
 * button's tooltip and in its confirm dialog, which describe the same thing.
 *
 * The shape is the same whatever the target's kind: the restore itself, the wait
 * it needs, then the optional post-restore action.
 */
function restoreSteps(t) {
  const c = t.config;
  if (!c.restore_enabled) return [];
  const wait = c.restore_wait_seconds ?? DEFAULT_RESTORE_WAIT;
  const postKind = c.post_restore_kind ?? 'none';

  return [
    ...(c.restore_kind === 'wol'
      ? wakeSentences(c, wait, postKind === 'none')
      : stepSentences(c, 'restore_', c.restore_kind, wait)),
    ...stepSentences(c, 'post_restore_', postKind, wait)
  ].map((sentence, i) => `${i + 1}. ${sentence}`);
}

/** The wake, and — when nothing follows it — the wait for the target itself. A
 *  post-restore action waits on the machine it is about to act on instead. */
function wakeSentences(c, wait, waitsForTarget) {
  const sentences = [];
  if (c.wol_mac) {
    const relay = relays.find((r) => r.id === c.wake_relay_id);
    sentences.push(c.wake_mode === 'relay'
      ? `Ask relay "${relay?.name ?? `#${c.wake_relay_id}`}" to wake ${c.wol_mac}.`
      : `Wake ${c.wol_mac} with a magic packet to ${c.wol_broadcast || 'every attached network'}.`);
  }
  if (waitsForTarget) sentences.push(`Wait up to ${wait}s for the target to answer.`);
  return sentences;
}

/** What one step does, one sentence per part — the same list for either step,
 *  since the two are the same shape. */
function stepSentences(c, p, stepKind, wait) {
  switch (stepKind) {
    case 'ssh':
    case 'winrm': {
      const proto = PROTO_LABELS[stepKind];
      return [
        `Wait up to ${wait}s for ${proto} to answer.`,
        `Then run over ${proto}: ${c[`${p}command`]}`
      ];
    }
    case 'k8s': return [
      `Wait up to ${wait}s for the API server to answer.`,
      c[`${p}uncordon`] ? 'Uncordon every node.' : null,
      c[`${p}path`] ? `Send ${c[`${p}method`] ?? 'PATCH'} ${c[`${p}path`]}` : null,
      c[`${p}restart_deployments`] ? 'Restart every Deployment outside kube-system.' : null
    ].filter(Boolean);
    case 'http': return [
      // Only a target that logs in has a probe safe to retry; every other HTTP
      // request is sent once.
      c[`${p}inherit`] && c.auth_scheme === 'login' && wait > 0
        ? `Wait up to ${wait}s for ${c.login_url} to accept the login.`
        : null,
      `Send ${c[`${p}method`] ?? 'POST'} ${c[`${p}url`]}`
    ].filter(Boolean);
    default: return [];
  }
}

/** Whether the target has a restore configured at all. The server refuses to
 *  store one that would do nothing, so the toggle is the whole test. */
function hasRestore(t) {
  return !!t.config.restore_enabled;
}

function renderTargetTable() {
  renderTable($targetTable, {
    className: 'endpoints target-table',
    colWidths: ['9%', '15%', '8%', '15%', '15%', '11%', '11%', '16%'],
    headers: ['Status', 'Name', 'Type', 'Connection', 'Runs on trigger', 'Credentials', 'Last activity', ''],
    rows: targets,
    empty: ['No action targets yet', 'Add the machines and services to act on using the form below.'],
    cells: (t) => targetRowCells(t)
  });

  // Whatever put a restore on screen — this page starting one, an auto-restore
  // the watcher started, or another browser — keeps the phase line moving.
  if (targets.some((t) => t.restore_progress)) scheduleRestorePoll();
}

function targetRowCells(t) {
  const [editBtn, delBtn] = editDeleteButtons({
    onEdit: () => targetForm.toEditMode(t),
    confirm: {
      title: 'Delete action target?',
      body: `"${t.name}" and its stored credentials will be permanently deleted. Any action group step that runs it will stop working.`,
      confirmText: 'Delete target'
    },
    onDelete: async () => {
      await actionTargets.remove(t.id);
      targetForm.forgetIfEditing(t.id);
      await refreshAll();
    }
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

  const restoreBtn = el('button', { class: 'btn ghost small' }, t.restore_progress ? 'Restoring…' : 'Restore');
  if (t.restore_progress) {
    // Already coming back — starting a second pass would send the restore
    // request twice, and it need not be idempotent. The server refuses it
    // too; this is so the button never offers it.
    restoreBtn.disabled = true;
    restoreBtn.title = `Restore in progress: ${t.restore_progress.phase}`;
  } else if (!hasRestore(t)) {
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

  return [
    el('td', {}, targetStatusPill(t)),
    el('td', { class: 'truncate', title: t.name }, el('strong', {}, t.name)),
    el('td', { class: 'truncate' }, KIND_LABELS[t.kind] ?? t.kind),
    el('td', { class: 'target-cell', title: targetConnection(t) }, targetConnection(t)),
    el('td', { class: 'target-cell', title: targetAction(t) }, targetAction(t)),
    el('td', { class: 'truncate', title: credentials }, credentials),
    targetActivityCell(t),
    // Not actionsCell(): this row's four buttons have their own cell class.
    el('td', { class: 'actions-cell' }, editBtn, delBtn, runBtn, restoreBtn)
  ];
}

// ---------- action groups (ordered stages of parallel steps) ----------

const $igForm = document.getElementById('igroup-form');
const $igTable = document.getElementById('igroup-table');
const $stageList = document.getElementById('stage-list');
const $stageAddBtn = document.getElementById('stage-add-btn');
const $igFlatlineGroupChecks = document.getElementById('ig-flatline-group-checks');
const igroupFormSection = initCollapsible('actions:igroup-form',
  document.getElementById('igroup-form-header'), document.getElementById('igroup-form-body'));
const igDirty = initDirtyNote($igForm, document.getElementById('igroup-dirty'),
  document.getElementById('igroup-save-note'));

/** The gap held before every stage but the first — server default, mirrored here. */
const DEFAULT_STAGE_WAIT = 5;

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
    await flatlineGroupsApi.update(fg.id, { ...fg, action_group_ids: [...fg.action_group_ids, actionGroupId] });
  }
  for (const id of toRemove) {
    const fg = flatlineGroups.find((g) => g.id === id);
    await flatlineGroupsApi.update(fg.id, { ...fg, action_group_ids: fg.action_group_ids.filter((x) => x !== actionGroupId) });
  }
}

const igForm = initEntityForm({
  form: $igForm,
  els: {
    title: document.getElementById('igroup-form-title'),
    error: document.getElementById('igroup-error'),
    submit: document.getElementById('igroup-submit'),
    cancel: document.getElementById('igroup-cancel'),
    reset: document.getElementById('igroup-reset'),
    saveNote: document.getElementById('igroup-save-note')
  },
  section: igroupFormSection,
  siblingSection: () => targetFormSection,
  dirty: igDirty,
  noun: 'action group',
  itemLabel: 'group',
  api: actionGroups,
  reset: () => {
    stages = [];
    renderStages();
    renderIgFlatlineGroupChecks();
  },
  fill: (g) => {
    stages = g.stages.map((st) => ({
      pass_rule: st.pass_rule,
      on_failure: st.on_failure ?? null,
      wait_seconds: st.wait_seconds ?? DEFAULT_STAGE_WAIT,
      steps: st.steps.map((s) => ({ ...s }))
    }));
    $igForm.elements.namedItem('name').value = g.name;
    $igForm.elements.namedItem('on_failure').value = g.on_failure;
    $igForm.elements.namedItem('stop_on_restore').checked = !!g.stop_on_restore;
    $igForm.elements.namedItem('enabled').checked = !!g.enabled;
    renderStages();
    renderIgFlatlineGroupChecks(
      flatlineGroups.filter((fg) => fg.action_group_ids.includes(g.id)).map((fg) => fg.id));
  },
  collect: () => ({
    name: $igForm.elements.namedItem('name').value,
    on_failure: $igForm.elements.namedItem('on_failure').value,
    stop_on_restore: $igForm.elements.namedItem('stop_on_restore').checked,
    enabled: $igForm.elements.namedItem('enabled').checked,
    stages: stages.filter((st) => st.steps.length > 0)
  }),
  // The assignment lives on each Flatline group, so it is written separately —
  // before the reload, so the refreshed list already reflects it.
  refresh: async (saved) => {
    await applyFlatlineGroupAssignments(saved.id, selectedIgFlatlineGroupIds());
    await refreshAll();
  },
  findSaved: (id) => igroups.find((g) => g.id === id)
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
  renderTable($igTable, {
    headers: ['Status', 'Group', 'Stages (in order)', 'On stage failure', 'Assigned to', ''],
    rows: igroups,
    empty: ['No action groups yet', 'Create an ordered sequence of targets using the form below.'],
    cells: (g) => {
      // "+" joins what runs at once, "," what follows it once a wait is up, and
      // "→" separates stages, carrying the gap held between them.
      const stageText = g.stages.length
        ? g.stages.map((st, i) => {
            const gap = i === 0 ? '' : st.wait_seconds > 0 ? `  →(${st.wait_seconds}s)→  ` : '  →  ';
            return `${gap}${i + 1}. ${stageStepText(st)}`;
          }).join('')
        : '—';
      const hasOverride = g.stages.some((st) => st.on_failure);

      return [
        el('td', {}, enabledPill(g.enabled)),
        el('td', {}, el('strong', {}, g.name)),
        el('td', { class: 'target-cell', title: stageText }, stageText),
        el('td', {},
          g.on_failure === 'stop' ? 'stop sequence' : 'continue',
          hasOverride ? el('span', { class: 'hint', title: 'Some stages override this' }, ' · overrides') : null),
        el('td', { class: 'mono' }, `${g.assigned_count} Flatline group(s)`),
        actionsCell(editDeleteButtons({
          onEdit: () => igForm.toEditMode(g),
          confirm: {
            title: 'Delete action group?',
            body: `"${g.name}" will be deleted. The action targets it uses are still available, only this sequence of steps is removed.`,
            confirmText: 'Delete group'
          },
          onDelete: async () => {
            await actionGroups.remove(g.id);
            igForm.forgetIfEditing(g.id);
            await refreshAll();
          }
        }))
      ];
    }
  });
}

// ---------- live restore progress ----------
// A restore opens by waiting minutes for a host to boot, so the 20s refresh
// below is far too slow to read as progress. While one is running this polls
// just the restore status and re-renders only the targets table — a full
// refresh would rebuild the forms and the relay pickers every few seconds for
// one line of text.

const RESTORE_POLL_MS = 3000;
let restoreTimer = null;

function scheduleRestorePoll() {
  if (restoreTimer !== null) return;
  restoreTimer = setTimeout(() => void pollRestores(), RESTORE_POLL_MS);
}

async function pollRestores() {
  restoreTimer = null;
  const live = targets.filter((t) => t.restore_progress);
  if (live.length === 0) return;

  const statuses = await Promise.all(live.map((t) => getRestoreStatus(t.id).catch(() => null)));

  let settled = false;
  live.forEach((t, i) => {
    const status = statuses[i];
    if (!status) return; // a failed poll: leave the row as it was and try again
    t.restore_progress = status.running ? status.progress : null;
    if (!status.running) {
      t.last_activity = status.last_activity;
      settled = true;
    }
  });

  renderTargetTable(); // schedules the next poll if anything is still running
  // The last one finished: a full refresh picks up the health dot it moved.
  if (settled && !targets.some((t) => t.restore_progress)) void refreshAll();
}

// ---------- boot ----------

function renderAll() {
  renderRelayOptions();
  renderTargetTable();
  renderIgTable();
  renderStages();
  // Keep the checklist valid without clobbering an in-progress edit.
  const editingIg = igForm.editingId;
  renderIgFlatlineGroupChecks(editingIg == null
    ? selectedIgFlatlineGroupIds()
    : flatlineGroups.filter((fg) => fg.action_group_ids.includes(editingIg)).map((fg) => fg.id));
}

async function refreshAll() {
  [targets, igroups, flatlineGroups, relays] = await Promise.all([
    actionTargets.list(), actionGroups.list(), flatlineGroupsApi.list(), relaysApi.list()
  ]);
  loaded = true;
  renderAll();
}

/**
 * Just the target rows. A step running or a run finishing changes what they say
 * — last activity, health, restore progress — and nothing else on this page:
 * the groups, relays and Flatline groups only change when someone edits them.
 *
 * So this deliberately does not call refreshAll, which would rebuild the forms,
 * the stage editor and the relay pickers out from under whoever is using them.
 * It is the same reason pollRestores redraws only this table.
 *
 * Note it leaves `loaded` alone: it populates one of the four lists, so it can
 * never be the thing that qualifies the page to save a snapshot.
 */
async function refreshTargets() {
  try {
    targets = await actionTargets.list();
    renderTargetTable();
  } catch (err) {
    console.error('target refresh failed:', err);
  }
}

targetForm.toAddMode();
igForm.toAddMode();

// Fill the tables from last session's data so the page is not blank while the
// live lists are in flight; refreshAll replaces them a round trip later.
const snapshot = loadSnapshot('actions');
if (snapshot) {
  ({ targets, igroups, flatlineGroups, relays } = snapshot);
  // A restore that was running when the snapshot was taken may well have
  // finished since. Progress is live state, so it is dropped rather than
  // replayed — the refresh below reports where each target actually is.
  for (const t of targets) t.restore_progress = null;
  renderAll();
}
saveSnapshotOnExit('actions', () => (loaded ? { targets, igroups, flatlineGroups, relays } : null));

void refreshAll();
// Picks up the background connectivity dot (server rechecks targets ~every minute).
setInterval(() => void refreshAll(), 20_000);

// The banners are on every page and own this page's change stream; the target
// rows ride along on it. The sweep above reconciles the whole page, while this
// reacts to what actually happened — a run's steps land seconds apart, so
// waiting out the interval to show each one made a live sequence read as a
// stalled one. health: this page shows the targets' connectivity dots.
watchBanners({ health: true, onChange: () => void refreshTargets() });
