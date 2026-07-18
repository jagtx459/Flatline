import {
  listNotificationChannels, createNotificationChannel, updateNotificationChannel,
  deleteNotificationChannel, testNotificationChannel,
  getKeyStatus, rotateKey, setKey,
  getSettings, putSettings,
  getSecurityConfig, setSitePassword, removeSitePassword
} from './api.js';
import { el, clear, fmtDateTime, initCollapsible } from './dom.js';
import { initHeaderAuth, refreshHeaderAuth } from './header.js';

initHeaderAuth();

let channels = [];

const KIND_LABELS = {
  webhook: 'Webhook', discord: 'Discord', ntfy: 'ntfy', email: 'Email'
};

// Maps a kind's secret field -> form input name (same pattern as actions.js).
const SECRET_INPUTS = {
  webhook: { url: 'webhook_url_field', token: 'webhook_token' },
  discord: { webhook_url: 'discord_webhook_url' },
  ntfy:    { token: 'ntfy_token', password: 'ntfy_password' },
  email:   { password: 'email_password' }
};

const EVENTS = [
  ['endpoint_down',  'Endpoint DOWN'],
  ['endpoint_up',    'Endpoint recovered (UP)'],
  ['group_armed',    'Flatline group armed (countdown started)'],
  ['group_disarmed', 'Flatline group recovered (disarmed)'],
  ['group_triggered','Flatline group TRIGGERED (actions running)'],
  ['action_ok',      'Action step succeeded'],
  ['action_failed',  'Action step failed']
];
const DEFAULT_EVENTS = ['endpoint_down', 'group_armed', 'group_disarmed', 'group_triggered', 'action_failed'];

// ---------- channel form ----------

const $form = document.getElementById('channel-form');
const $formTitle = document.getElementById('channel-form-title');
const $formError = document.getElementById('channel-error');
const $formSubmit = document.getElementById('channel-submit');
const $formCancel = document.getElementById('channel-cancel');
const $formReset = document.getElementById('channel-reset');
const $formTest = document.getElementById('channel-test');
const $formTestResult = document.getElementById('channel-test-result');
const $formSaveNote = document.getElementById('channel-save-note');
const $kind = document.getElementById('c-kind');
const $ntfyAuthScheme = document.getElementById('ntfy-auth-scheme');
const $channelTable = document.getElementById('channel-table');
const $eventChecks = document.getElementById('channel-event-checks');
const channelFormSection = initCollapsible('config:channel-form',
  document.getElementById('channel-form-header'), document.getElementById('channel-form-body'));

let editingChannelId = null;
let clearedSecrets = new Set();

function field(name) {
  return $form.elements.namedItem(name);
}

function syncKindSections() {
  const kind = $kind.value;
  for (const section of $form.querySelectorAll('.kind-section')) {
    section.style.display = section.dataset.kind === kind ? '' : 'none';
  }
  syncNtfyAuthFields();
  $formTestResult.textContent = '';
}
$kind.addEventListener('change', syncKindSections);

function syncNtfyAuthFields() {
  const scheme = $ntfyAuthScheme.value;
  for (const node of $form.querySelectorAll('[data-ntfy-auth]')) {
    node.style.display = node.dataset.ntfyAuth === scheme ? '' : 'none';
  }
}
$ntfyAuthScheme.addEventListener('change', syncNtfyAuthFields);

function renderEventChecks(selected) {
  clear($eventChecks);
  for (const [key, label] of EVENTS) {
    const cb = el('input', { type: 'checkbox', value: key });
    cb.checked = selected.includes(key);
    cb.dataset.event = '1';
    $eventChecks.append(el('label', { class: 'check' }, cb, el('span', {}, label)));
  }
}

function selectedEvents() {
  return [...$eventChecks.querySelectorAll('input[data-event]')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
}

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
    });
    const hint = el('span', {}, '· stored ✓ (leave blank to keep) ');
    state.append(hint, clearBtn);
  }
}

function collectConfig(kind) {
  const cfg = {
    events: selectedEvents(),
    title_template: field('title_template').value,
    body_template: field('body_template').value
  };
  switch (kind) {
    case 'ntfy':
      cfg.server_url = field('ntfy_server_url').value;
      cfg.topic = field('ntfy_topic').value;
      cfg.priority = field('ntfy_priority').value;
      cfg.auth_scheme = field('ntfy_auth_scheme').value;
      cfg.username = field('ntfy_username').value;
      break;
    case 'email':
      cfg.host = field('email_host').value;
      cfg.port = field('email_port').value;
      cfg.secure = field('email_secure').checked;
      cfg.from = field('email_from').value;
      cfg.to = field('email_to').value;
      cfg.username = field('email_username').value;
      break;
  }
  return cfg;
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

function resetChannelForm() {
  editingChannelId = null;
  $form.reset();
  $formTitle.textContent = 'Add notification channel';
  $formSubmit.textContent = 'Add channel';
  $formCancel.style.display = 'none';
  $formReset.style.display = '';
  $formError.textContent = '';
  $formSaveNote.textContent = '';
  renderEventChecks(DEFAULT_EVENTS);
  renderSecretStates('none', []);
  syncKindSections();
}

function fillChannelForm(c) {
  resetChannelForm();
  editingChannelId = c.id;
  field('name').value = c.name;
  $kind.value = c.kind;
  field('enabled').checked = !!c.enabled;

  const cfg = c.config;
  renderEventChecks(Array.isArray(cfg.events) ? cfg.events : []);
  field('title_template').value = cfg.title_template ?? '';
  field('body_template').value = cfg.body_template ?? '';
  switch (c.kind) {
    case 'ntfy':
      field('ntfy_server_url').value = cfg.server_url ?? '';
      field('ntfy_topic').value = cfg.topic ?? '';
      field('ntfy_priority').value = cfg.priority ?? '';
      field('ntfy_auth_scheme').value = cfg.auth_scheme ?? 'none';
      field('ntfy_username').value = cfg.username ?? '';
      break;
    case 'email':
      field('email_host').value = cfg.host ?? '';
      field('email_port').value = String(cfg.port ?? 587);
      field('email_secure').checked = !!cfg.secure;
      field('email_from').value = cfg.from ?? '';
      field('email_to').value = cfg.to ?? '';
      field('email_username').value = cfg.username ?? '';
      break;
  }

  renderSecretStates(c.kind, c.secret_fields);
  syncKindSections();
  $formTitle.textContent = `Edit channel: ${c.name}`;
  $formSubmit.textContent = 'Save changes';
  $formCancel.style.display = '';
  $formReset.style.display = 'none';
  channelFormSection.expand();
  $form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$formCancel.addEventListener('click', (e) => {
  e.preventDefault();
  resetChannelForm();
});

$formReset.addEventListener('click', () => resetChannelForm());

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
    const wasEditing = editingChannelId != null;
    try {
      const saved = wasEditing ? await updateNotificationChannel(editingChannelId, input) : await createNotificationChannel(input);
      $formError.textContent = '';
      await refreshChannels();
      if (wasEditing) {
        fillChannelForm(channels.find((c) => c.id === saved.id) ?? saved);
        $formSaveNote.textContent = 'Saved ✓';
      } else {
        resetChannelForm();
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
    $formTestResult.textContent = 'Sending test notification…';
    $formError.textContent = '';
    try {
      const result = await testNotificationChannel({
        id: editingChannelId ?? undefined,
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

function eventSummary(cfg) {
  const evs = Array.isArray(cfg.events) ? cfg.events : [];
  if (evs.length === 0) return 'no events selected';
  const labels = Object.fromEntries(EVENTS);
  return evs.map((e) => labels[e] ?? e).join(', ');
}

/** Enabled/paused + last delivery outcome — there's no live connectivity poll
 *  for notification channels (unlike action targets), so this reflects the
 *  most recent test or real send rather than a periodic background check. */
function channelStatusPill(c) {
  if (!c.enabled) {
    return el('span', { class: 'pill disabled' }, 'DISABLED');
  }
  if (!c.last_result) {
    return el('span', { class: 'pill up', title: 'Enabled — no test or delivery attempt yet' }, 'ENABLED');
  }
  const title = `${fmtDateTime(c.last_result.ts)} (${c.last_result.trigger}) — ${c.last_result.message}`;
  return c.last_result.ok
    ? el('span', { class: 'pill up', title }, 'OK')
    : el('span', { class: 'pill down', title }, 'FAILED');
}

function lastActivityText(c) {
  if (!c.last_result) return 'never';
  const source = c.last_result.trigger === 'test' ? 'test' : 'delivery';
  return `${fmtDateTime(c.last_result.ts)} (${source})`;
}

function renderChannelTable() {
  clear($channelTable);
  if (channels.length === 0) {
    $channelTable.append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, 'No notification channels yet'),
      el('div', {}, 'Add a webhook, Discord, ntfy, or email channel using the form below.')));
    return;
  }

  const tbody = el('tbody', {});
  for (const c of channels) {
    const editBtn = el('button', { class: 'btn ghost small' }, 'Edit');
    editBtn.addEventListener('click', () => fillChannelForm(c));
    const delBtn = el('button', { class: 'btn danger-ghost small' }, 'Delete');
    delBtn.addEventListener('click', () => {
      void (async () => {
        if (!confirm(`Delete channel "${c.name}"?`)) return;
        await deleteNotificationChannel(c.id);
        if (editingChannelId === c.id) resetChannelForm();
        await refreshChannels();
      })();
    });
    const testBtn = el('button', { class: 'btn ghost small' }, 'Test');
    testBtn.addEventListener('click', () => {
      void (async () => {
        testBtn.disabled = true;
        try {
          const result = await testNotificationChannel({ id: c.id, kind: c.kind, config: c.config, secrets: {} });
          alert(`${result.ok ? '✓ delivered' : '✕ failed'}: ${result.message}`);
        } catch (err) {
          alert(`Error: ${err.message}`);
        } finally {
          testBtn.disabled = false;
          await refreshChannels();
        }
      })();
    });

    tbody.append(el('tr', {},
      el('td', {}, channelStatusPill(c)),
      el('td', {}, el('strong', {}, c.name)),
      el('td', {}, KIND_LABELS[c.kind] ?? c.kind),
      el('td', { class: 'target-cell', title: eventSummary(c.config) }, eventSummary(c.config)),
      el('td', {}, c.secret_fields.length
        ? el('span', { class: 'badge' }, `🔒 ${c.secret_fields.join(', ')}`)
        : '—'),
      el('td', { class: 'target-cell' }, lastActivityText(c)),
      el('td', {}, el('span', { style: 'display:inline-flex;gap:6px' }, testBtn, editBtn, delBtn))
    ));
  }

  const table = el('table', { class: 'endpoints' });
  table.append(
    el('thead', {}, el('tr', {},
      el('th', {}, 'Status'), el('th', {}, 'Name'), el('th', {}, 'Service'), el('th', {}, 'Events'),
      el('th', {}, 'Credentials'), el('th', {}, 'Last activity'), el('th', {}, ''))),
    tbody
  );
  $channelTable.append(table);
}

async function refreshChannels() {
  channels = await listNotificationChannels();
  renderChannelTable();
}

// ---------- encryption key ----------

const $keyStatus = document.getElementById('key-status');
const $keyRotateSection = document.getElementById('key-rotate-section');
const $keyRotate = document.getElementById('key-rotate');
const $keyForm = document.getElementById('key-form');
const $keyGenerate = document.getElementById('key-generate');
const $keyNote = document.getElementById('key-note');
const $keyError = document.getElementById('key-error');

async function refreshKeyStatus() {
  const s = await getKeyStatus();
  const items = `${s.encrypted_items} encrypted item(s) stored`;
  if (s.source === 'env') {
    $keyStatus.textContent = `Key source: FLATLINE_SECRET_KEY environment variable — ${items}. ` +
      'To rotate, set a new key below, then update the environment variable to the same value before the next restart.';
    $keyRotateSection.style.display = 'none';
  } else {
    $keyStatus.textContent = `Key source: auto-generated key file in the data directory — ${items}.`;
    $keyRotateSection.style.display = '';
  }
}

$keyRotate.addEventListener('click', () => {
  void (async () => {
    if (!confirm('Generate a fresh encryption key and re-encrypt all stored credentials?\n\n' +
      'The new key replaces the key file in the data directory — back it up afterwards.')) return;
    $keyRotate.disabled = true;
    $keyError.textContent = '';
    $keyNote.textContent = '';
    try {
      const result = await rotateKey();
      $keyNote.textContent = `✓ ${result.note}`;
      await refreshKeyStatus();
    } catch (err) {
      $keyError.textContent = err.message;
    } finally {
      $keyRotate.disabled = false;
    }
  })();
});

$keyGenerate.addEventListener('click', () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  $keyForm.elements.namedItem('key').value =
    [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  $keyNote.textContent = 'Generated locally in your browser — copy it somewhere safe before saving.';
  $keyError.textContent = '';
});

$keyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const key = $keyForm.elements.namedItem('key').value.trim();
    if (!key) { $keyError.textContent = 'enter or generate a key first'; return; }
    if (!confirm('Re-encrypt all stored credentials with this key?\n\n' +
      'Make sure you have it saved — without it stored credentials are unrecoverable.')) return;
    $keyError.textContent = '';
    $keyNote.textContent = '';
    try {
      const result = await setKey(key);
      $keyNote.textContent = `✓ ${result.note}`;
      $keyForm.reset();
      await refreshKeyStatus();
    } catch (err) {
      $keyError.textContent = err.message;
    }
  })();
});

// ---------- general settings (retention) ----------

const $settingsForm = document.getElementById('settings-form');
const $settingsNote = document.getElementById('settings-note');

async function loadSettings() {
  const s = await getSettings();
  $settingsForm.elements.namedItem('retention_days').value = s.retention_days ?? '14';
}

$settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    $settingsNote.textContent = '';
    $settingsNote.className = 'note';
    try {
      await putSettings({
        retention_days: Number($settingsForm.elements.namedItem('retention_days').value)
      });
      $settingsNote.textContent = 'Saved ✓';
      setTimeout(() => { $settingsNote.textContent = ''; }, 2500);
    } catch (err) {
      $settingsNote.className = 'error';
      $settingsNote.textContent = err.message;
    }
  })();
});

// ---------- site access (password + allowed hosts) ----------

const $authStatus = document.getElementById('auth-status');
const $passwordForm = document.getElementById('password-form');
const $passwordCap = document.getElementById('password-cap');
const $passwordSet = document.getElementById('password-set');
const $passwordRemove = document.getElementById('password-remove');
const $passwordNote = document.getElementById('password-note');
const $passwordError = document.getElementById('password-error');
const $hostsForm = document.getElementById('hosts-form');
const $hostsSave = document.getElementById('hosts-save');
const $hostsNote = document.getElementById('hosts-note');
const $hostsError = document.getElementById('hosts-error');

async function refreshSecurity() {
  const s = await getSecurityConfig();

  if (s.password_source === 'env') {
    $authStatus.textContent = 'Login required — the password is set via the FLATLINE_PASSWORD ' +
      'environment variable and can only be changed there.';
    $passwordForm.querySelectorAll('input, button[type=submit]').forEach((n) => { n.disabled = true; });
    $passwordRemove.style.display = 'none';
  } else if (s.password_source === 'settings') {
    $authStatus.textContent = 'Login required — a site password is set. Sessions last 7 days.';
    $passwordCap.textContent = 'Change the site password (min 8 chars)';
    $passwordSet.textContent = 'Change password';
    $passwordRemove.style.display = '';
  } else {
    $authStatus.textContent = 'No password set — anyone who can reach this port has full control of ' +
      'monitoring and actions. Set one below (or via FLATLINE_PASSWORD) to require a login.';
    $passwordCap.textContent = 'Set a site password (min 8 chars)';
    $passwordSet.textContent = 'Set password';
    $passwordRemove.style.display = 'none';
  }
  void refreshHeaderAuth();

  const $hostsInput = $hostsForm.elements.namedItem('allowed_hosts');
  $hostsInput.value = s.allowed_hosts ?? '';
  if (s.allowed_hosts_source === 'env') {
    $hostsInput.disabled = true;
    $hostsSave.disabled = true;
    $hostsNote.textContent = 'Set via FLATLINE_ALLOWED_HOSTS — change it there.';
  }
}

$passwordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    $passwordError.textContent = '';
    $passwordNote.textContent = '';
    const pw = $passwordForm.elements.namedItem('password').value;
    const pw2 = $passwordForm.elements.namedItem('password2').value;
    if (pw !== pw2) { $passwordError.textContent = 'passwords do not match'; return; }
    if (!confirm('Require this password to access Flatline?\n\nOther active sessions will be logged out.')) return;
    try {
      const result = await setSitePassword(pw);
      $passwordForm.reset();
      $passwordNote.textContent = `✓ ${result.note}`;
      await refreshSecurity();
    } catch (err) {
      $passwordError.textContent = err.message;
    }
  })();
});

$passwordRemove.addEventListener('click', () => {
  void (async () => {
    if (!confirm('Remove the site password?\n\nThe UI and API will be open to anyone who can reach this port.')) return;
    $passwordError.textContent = '';
    try {
      const result = await removeSitePassword();
      $passwordNote.textContent = `✓ ${result.note}`;
      await refreshSecurity();
    } catch (err) {
      $passwordError.textContent = err.message;
    }
  })();
});

$hostsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    $hostsError.textContent = '';
    $hostsNote.textContent = '';
    try {
      await putSettings({ allowed_hosts: $hostsForm.elements.namedItem('allowed_hosts').value });
      $hostsNote.textContent = 'Saved ✓';
      setTimeout(() => { $hostsNote.textContent = ''; }, 2500);
    } catch (err) {
      $hostsError.textContent = err.message;
    }
  })();
});

// ---------- boot ----------

resetChannelForm();
void refreshChannels();
void loadSettings();
void refreshKeyStatus();
void refreshSecurity();
// Picks up delivery results from real (non-test) events as they happen.
setInterval(() => void refreshChannels(), 20_000);
