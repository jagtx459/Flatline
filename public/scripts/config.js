import {
  notificationChannels, relays as relaysApi,
  getKeyStatus, rotateKey, setKey,
  getSettings, putSettings,
  getSecurityConfig, setSitePassword, removeSitePassword,
  exportConfig, importConfig, resetApp, downloadBackup, restoreBackup
} from './api.js';
import {
  el, clear, enabledPill, fmtDateTime, initCollapsible, initDirtyNote, initTabs,
  wireFileUpload, confirmDialog, alertDialog, initHelp, toggleByData
} from './dom.js';
import {
  initEntityForm, initSecretFields, renderTable, editDeleteButtons, actionsCell
} from './crud.js';
import { initHeaderAuth, refreshHeaderAuth } from './header.js';
import { loadSnapshot, saveSnapshotOnExit } from './snapshot.js';
import { watchBanners } from './banners.js';

initHeaderAuth();
initHelp();
watchBanners();

const configTabs = initTabs('config', document.getElementById('config-tabs'));

document.getElementById('baseurl-jump').addEventListener('click', () => configTabs.show('general'));

let channels = [];
let channelsLoaded = false; 

const KIND_LABELS = {
  webhook: 'Webhook', discord: 'Discord', ntfy: 'ntfy', email: 'Email', apprise: 'Apprise'
};

const SECRET_INPUTS = {
  webhook: { url: 'webhook_url_field', token: 'webhook_token' },
  discord: { webhook_url: 'discord_webhook_url' },
  ntfy:    { token: 'ntfy_token', password: 'ntfy_password' },
  email:   { password: 'email_password' },
  apprise: { urls: 'apprise_urls' }
};

const EVENTS = [
  ['endpoint_down',  'Endpoint DOWN'],
  ['endpoint_up',    'Endpoint recovered (UP)'],
  ['group_armed',    'Flatline group armed (countdown started)'],
  ['group_disarmed', 'Flatline group recovered (disarmed)'],
  ['group_triggered','Flatline group TRIGGERED (actions running)'],
  ['action_ok',      'Action step succeeded'],
  ['action_failed',  'Action step failed'],
  ['run_started',    'Action group run started'],
  ['run_completed',  'Action group run completed'],
  ['run_failed',     'Action group run FAILED (or cancelled, or cut short by a restart)']
];
const DEFAULT_EVENTS = [
  'endpoint_down', 'group_armed', 'group_disarmed', 'group_triggered', 'action_failed', 'run_failed'
];

// ---------- channel form ----------

const $form = document.getElementById('channel-form');
const $formError = document.getElementById('channel-error');
const $formTest = document.getElementById('channel-test');
const $formTestResult = document.getElementById('channel-test-result');
const $formSaveNote = document.getElementById('channel-save-note');
const $kind = document.getElementById('c-kind');
const $ntfyAuthScheme = document.getElementById('ntfy-auth-scheme');
const $channelTable = document.getElementById('channel-table');
const $eventChecks = document.getElementById('channel-event-checks');
const channelFormSection = initCollapsible('config:channel-form',
  document.getElementById('channel-form-header'), document.getElementById('channel-form-body'));
const channelDirty = initDirtyNote($form, document.getElementById('channel-dirty'), $formSaveNote);
const channelSecrets = initSecretFields($form, {
  sectionAttr: 'kind',
  onDirty: () => channelDirty.markDirty()
});

function field(name) {
  return $form.elements.namedItem(name);
}

function syncKindSections() {
  toggleByData($form, 'kind', $kind.value);
  syncNtfyAuthFields();
  $formTestResult.textContent = '';
}
$kind.addEventListener('change', syncKindSections);

function syncNtfyAuthFields() {
  toggleByData($form, 'ntfy-auth', $ntfyAuthScheme.value);
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
    case 'apprise':
      cfg.server_url = field('apprise_server_url').value;
      cfg.config_key = field('apprise_config_key').value;
      cfg.tags = field('apprise_tags').value;
      break;
  }
  return cfg;
}

const channelForm = initEntityForm({
  form: $form,
  els: {
    title: document.getElementById('channel-form-title'),
    error: $formError,
    submit: document.getElementById('channel-submit'),
    cancel: document.getElementById('channel-cancel'),
    reset: document.getElementById('channel-reset'),
    saveNote: $formSaveNote
  },
  section: channelFormSection,
  dirty: channelDirty,
  noun: 'notification channel',
  itemLabel: 'channel',
  api: notificationChannels,
  reset: () => {
    renderEventChecks(DEFAULT_EVENTS);
    channelSecrets.render('none', []);
    syncKindSections();
  },
  fill: (c) => {
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
      case 'apprise':
        field('apprise_server_url').value = cfg.server_url ?? '';
        field('apprise_config_key').value = cfg.config_key ?? '';
        field('apprise_tags').value = cfg.tags ?? '';
        break;
    }

    channelSecrets.render(c.kind, c.secret_fields);
    syncKindSections();
  },
  collect: () => {
    const kind = $kind.value;
    return {
      name: field('name').value,
      kind,
      config: collectConfig(kind),
      secrets: channelSecrets.collect(SECRET_INPUTS[kind]),
      enabled: field('enabled').checked
    };
  },
  findSaved: (id) => channels.find((c) => c.id === id),
  refresh: refreshChannels
});

$formTest.addEventListener('click', () => {
  void (async () => {
    const kind = $kind.value;
    $formTestResult.className = 'note';
    $formTestResult.textContent = 'Sending test notification…';
    $formError.textContent = '';
    try {
      const result = await notificationChannels.test({
        id: channelForm.editingId ?? undefined,
        kind,
        config: collectConfig(kind),
        secrets: channelSecrets.collect(SECRET_INPUTS[kind])
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
  renderTable($channelTable, {
    headers: ['Status', 'Name', 'Service', 'Events', 'Credentials', 'Last activity', ''],
    rows: channels,
    empty: ['No notification channels yet',
      'Add a webhook, Discord, ntfy, email, or Apprise channel using the form below.'],
    cells: (c) => {
      const testBtn = el('button', { class: 'btn ghost small' }, 'Test');
      testBtn.addEventListener('click', () => {
        void (async () => {
          testBtn.disabled = true;
          try {
            const result = await notificationChannels.test({ id: c.id, kind: c.kind, config: c.config, secrets: {} });
            await alertDialog({ title: result.ok ? 'Test delivered' : 'Test failed', body: result.message });
          } catch (err) {
            await alertDialog({ title: 'Test failed', body: err.message });
          } finally {
            testBtn.disabled = false;
            await refreshChannels();
          }
        })();
      });

      return [
        el('td', {}, channelStatusPill(c)),
        el('td', {}, el('strong', {}, c.name)),
        el('td', {}, KIND_LABELS[c.kind] ?? c.kind),
        el('td', { class: 'target-cell', title: eventSummary(c.config) }, eventSummary(c.config)),
        el('td', {}, c.secret_fields.length
          ? el('span', { class: 'badge' }, `🔒 ${c.secret_fields.join(', ')}`)
          : '—'),
        el('td', { class: 'target-cell' }, lastActivityText(c)),
        actionsCell(testBtn, editDeleteButtons({
          onEdit: () => channelForm.toEditMode(c),
          confirm: {
            title: 'Delete notification channel?',
            body: `"${c.name}" will be deleted and will stop receiving alerts. This can't be undone.`,
            confirmText: 'Delete channel'
          },
          onDelete: async () => {
            await notificationChannels.remove(c.id);
            channelForm.forgetIfEditing(c.id);
            await refreshChannels();
          }
        }))
      ];
    }
  });
}

async function refreshChannels() {
  channels = await notificationChannels.list();
  channelsLoaded = true;
  renderChannelTable();
}

// ---------- encryption key ----------

const $keyStatus = document.getElementById('key-status');
const $keyRotateSection = document.getElementById('key-rotate-section');
const $keyRotate = document.getElementById('key-rotate');
const $keyForm = document.getElementById('key-form');
const $keyGenerate = document.getElementById('key-generate');
const $keyUploadBtn = document.getElementById('key-upload-btn');
const $keyUpload = document.getElementById('key-upload');
const $keyNote = document.getElementById('key-note');
const $keyError = document.getElementById('key-error');
const keyDirty = initDirtyNote($keyForm, document.getElementById('key-dirty'));

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
    const ok = await confirmDialog({
      title: 'Rotate encryption key?',
      body: [
        'A fresh key will be generated and every stored credential re-encrypted under it.',
        'The new key replaces the key file in the data directory. Back it up afterwards; without it, stored credentials CANNOT be recovered.'
      ],
      confirmText: 'Rotate key',
      danger: true
    });
    if (!ok) return;
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
  keyDirty.markDirty();
});

wireFileUpload($keyUploadBtn, $keyUpload, $keyForm.elements.namedItem('key'), () => {
  const field = $keyForm.elements.namedItem('key');
  field.value = field.value.trim();
  $keyNote.textContent = 'Loaded from file — verify it, then re-encrypt.';
  $keyError.textContent = '';
});

$keyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const key = $keyForm.elements.namedItem('key').value.trim();
    if (!key) { $keyError.textContent = 'enter or generate a key first'; return; }
    const ok = await confirmDialog({
      title: 'Re-encrypt with this key?',
      body: [
        'Every stored credential will be re-encrypted with the key you entered.',
        'Make sure you store it somewhere safe; without it, credentials CANNOT be recovered.'
      ],
      confirmText: 'Re-encrypt',
      danger: true
    });
    if (!ok) return;
    $keyError.textContent = '';
    $keyNote.textContent = '';
    try {
      const result = await setKey(key);
      $keyNote.textContent = `✓ ${result.note}`;
      $keyForm.reset();
      keyDirty.markClean();
      await refreshKeyStatus();
    } catch (err) {
      $keyError.textContent = err.message;
    }
  })();
});

// ---------- general settings (retention) ----------

const $settingsForm = document.getElementById('settings-form');
const $settingsNote = document.getElementById('settings-note');
const settingsDirty = initDirtyNote($settingsForm, document.getElementById('settings-dirty'), $settingsNote);

async function loadSettings() {
  const s = await getSettings();
  $settingsForm.elements.namedItem('retention_days').value = s.retention_days ?? '14';
  settingsDirty.markClean();
  applyBaseUrl(s);
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
      settingsDirty.markClean();
      $settingsNote.textContent = 'Saved ✓';
      setTimeout(() => { $settingsNote.textContent = ''; }, 2500);
    } catch (err) {
      $settingsNote.className = 'error';
      $settingsNote.textContent = err.message;
    }
  })();
});

// ---------- wake-on-lan relays ----------
const RELAY_KIND_LABELS = { ssh: 'SSH', winrm: 'WinRM' };

/** Default wake command per relay kind. Windows needs nothing installed; the
 *  Linux default assumes the `wakeonlan` package (see the form's help block). */
const DEFAULT_WAKE_COMMAND = {
  ssh: 'wakeonlan {mac}',
  winrm: "$m = '{mac}'.Replace('-',':').Split(':') | ForEach-Object { [byte]('0x' + $_) }; "
    + '$p = [byte[]]@(0xFF) * 6 + [byte[]]$m * 16; '
    + '$u = New-Object System.Net.Sockets.UdpClient; $u.EnableBroadcast = $true; '
    + "[void]$u.Send($p, $p.Length, '255.255.255.255', 9); $u.Close()"
};

const RELAY_SECRET_INPUTS = {
  ssh: { password: 'ssh_password', private_key: 'ssh_private_key', passphrase: 'ssh_passphrase', sudo_password: 'ssh_sudo_password' },
  winrm: { password: 'winrm_password' }
};

const $relayForm = document.getElementById('relay-form');
const $relayTable = document.getElementById('relay-table');
const $relayTest = document.getElementById('relay-test');
const $relayTestResult = document.getElementById('relay-test-result');
const $relaySaveNote = document.getElementById('relay-save-note');
const $relayError = document.getElementById('relay-error');
const $relayKind = document.getElementById('r-kind');
const relayFormSection = initCollapsible('config:relay-form',
  document.getElementById('relay-form-header'), document.getElementById('relay-form-body'));
const relayDirty = initDirtyNote($relayForm, document.getElementById('relay-dirty'), $relaySaveNote);
const relaySecrets = initSecretFields($relayForm, {
  sectionAttr: 'relay-kind',
  onDirty: () => relayDirty.markDirty()
});

let relays = [];
let relaysLoaded = false;

const relayField = (name) => $relayForm.elements.namedItem(name);

function syncRelayKind() {
  toggleByData($relayForm, 'relay-kind', $relayKind.value);
  toggleByData($relayForm, 'relay-ssh-auth', relayField('ssh_auth_method').value);
  syncRelayWinrmTls();
  $relayTestResult.textContent = '';
}

/** The certificate fields only mean anything over HTTPS. */
function syncRelayWinrmTls() {
  $relayForm.querySelector('.relay-winrm-tls').hidden = !relayField('winrm_use_tls').checked;
}

relayField('winrm_use_tls').addEventListener('change', () => {
  const on = relayField('winrm_use_tls').checked;
  const $port = relayField('winrm_port');
  if ($port.value === (on ? '5985' : '5986')) $port.value = on ? '5986' : '5985';
  syncRelayWinrmTls();
});

$relayKind.addEventListener('change', () => {
  const cmd = relayField('wake_command');
  if (!cmd.value || Object.values(DEFAULT_WAKE_COMMAND).includes(cmd.value)) {
    cmd.value = DEFAULT_WAKE_COMMAND[$relayKind.value];
  }
  syncRelayKind();
});
relayField('ssh_auth_method').addEventListener('change', syncRelayKind);
document.getElementById('relay-cmd-reset').addEventListener('click', () => {
  relayField('wake_command').value = DEFAULT_WAKE_COMMAND[$relayKind.value];
  relayDirty.markDirty();
});
wireFileUpload(
  document.getElementById('relay-key-upload-btn'),
  document.getElementById('relay-key-upload'),
  relayField('ssh_private_key')
);

function collectRelayConfig(kind) {
  return kind === 'ssh'
    ? {
        host: relayField('ssh_host').value,
        port: Number(relayField('ssh_port').value) || 22,
        username: relayField('ssh_username').value,
        auth_method: relayField('ssh_auth_method').value
      }
    : {
        host: relayField('winrm_host').value,
        port: Number(relayField('winrm_port').value) || (relayField('winrm_use_tls').checked ? 5986 : 5985),
        domain: relayField('winrm_domain').value,
        username: relayField('winrm_username').value,
        use_tls: relayField('winrm_use_tls').checked,
        insecure_tls: relayField('winrm_insecure_tls').checked,
        ca_cert: relayField('winrm_ca_cert').value
      };
}

const relayForm = initEntityForm({
  form: $relayForm,
  els: {
    title: document.getElementById('relay-form-title'),
    error: $relayError,
    submit: document.getElementById('relay-submit'),
    cancel: document.getElementById('relay-cancel'),
    reset: document.getElementById('relay-reset'),
    saveNote: $relaySaveNote
  },
  section: relayFormSection,
  dirty: relayDirty,
  noun: 'relay',
  api: relaysApi,
  reset: () => {
    relayField('wake_command').value = DEFAULT_WAKE_COMMAND[$relayKind.value];
    relaySecrets.render('none', []);
    syncRelayKind();
  },
  fill: (r) => {
    relayField('name').value = r.name;
    $relayKind.value = r.kind;
    relayField('enabled').checked = !!r.enabled;
    relayField('wake_command').value = r.wake_command ?? '';
    relayField('network').value = r.network ?? '';

    const c = r.config;
    if (r.kind === 'ssh') {
      relayField('ssh_host').value = c.host ?? '';
      relayField('ssh_port').value = String(c.port ?? 22);
      relayField('ssh_username').value = c.username ?? '';
      relayField('ssh_auth_method').value = c.auth_method ?? 'password';
    } else {
      relayField('winrm_host').value = c.host ?? '';
      relayField('winrm_port').value = String(c.port ?? (c.use_tls ? 5986 : 5985));
      relayField('winrm_domain').value = c.domain ?? '';
      relayField('winrm_username').value = c.username ?? '';
      relayField('winrm_use_tls').checked = !!c.use_tls;
      relayField('winrm_insecure_tls').checked = !!c.insecure_tls;
      relayField('winrm_ca_cert').value = c.ca_cert ?? '';
    }

    relaySecrets.render(r.kind, r.secret_fields);
    syncRelayKind();
  },
  collect: () => {
    const kind = $relayKind.value;
    return {
      name: relayField('name').value,
      kind,
      config: collectRelayConfig(kind),
      wake_command: relayField('wake_command').value,
      network: relayField('network').value,
      secrets: relaySecrets.collect(RELAY_SECRET_INPUTS[kind]),
      enabled: relayField('enabled').checked
    };
  },
  findSaved: (id) => relays.find((r) => r.id === id),
  refresh: loadRelays
});

$relayTest.addEventListener('click', () => {
  void (async () => {
    const kind = $relayKind.value;
    $relayTestResult.className = 'note';
    $relayTestResult.textContent = 'Testing…';
    $relayError.textContent = '';
    try {
      const result = await relaysApi.test({
        id: relayForm.editingId ?? undefined,
        kind,
        config: collectRelayConfig(kind),
        secrets: relaySecrets.collect(RELAY_SECRET_INPUTS[kind])
      });
      $relayTestResult.className = result.ok ? 'note' : 'error';
      $relayTestResult.textContent = `${result.ok ? '✓' : '✕'} ${result.message}`;
    } catch (err) {
      $relayTestResult.className = 'error';
      $relayTestResult.textContent = err.message;
    }
  })();
});

function relayConnection(r) {
  const c = r.config;
  return r.kind === 'winrm'
    ? `${c.domain ? c.domain + '\\' : ''}${c.username}@${c.host}:${c.port}`
    : `${c.username}@${c.host}:${c.port}`;
}

function renderRelayTable() {
  renderTable($relayTable, {
    headers: ['Status', 'Name', 'Type', 'Connection', 'Network', 'Wake command', 'Credentials', ''],
    rows: relays,
    empty: ['No relays yet',
      'Add one only if you need to wake machines on a network Flatline is not attached to.'],
    cells: (r) => {
      const credentials = r.secret_fields.length ? `🔒 ${r.secret_fields.join(', ')}` : '—';
      return [
        el('td', {}, enabledPill(r.enabled)),
        el('td', { class: 'truncate', title: r.name }, el('strong', {}, r.name)),
        el('td', {}, RELAY_KIND_LABELS[r.kind] ?? r.kind),
        el('td', { class: 'target-cell', title: relayConnection(r) }, relayConnection(r)),
        el('td', { class: 'mono' }, r.network),
        el('td', { class: 'target-cell mono', title: r.wake_command }, r.wake_command),
        el('td', { class: 'truncate', title: credentials }, credentials),
        actionsCell(editDeleteButtons({
          onEdit: () => relayForm.toEditMode(r),
          confirm: {
            title: 'Delete relay?',
            body: [`"${r.name}" and its stored credentials will be permanently deleted.`,
              'Any action target set to wake through this relay will stop waking until you point it at another one.'],
            confirmText: 'Delete relay'
          },
          onDelete: async () => {
            await relaysApi.remove(r.id);
            relayForm.forgetIfEditing(r.id);
            await loadRelays();
          }
        }))
      ];
    }
  });
}

async function loadRelays() {
  relays = await relaysApi.list();
  relaysLoaded = true;
  renderRelayTable();
}

// ---------- site URL ----------
// Consumed by notification templates as {url}. FLATLINE_BASE_URL wins when set,
// in which case the field is shown read-only rather than hidden
const $baseUrlForm = document.getElementById('baseurl-form');
const $baseUrlStatus = document.getElementById('baseurl-status');
const $baseUrlNote = document.getElementById('baseurl-note');
const $baseUrlError = document.getElementById('baseurl-error');
const $baseUrlSave = document.getElementById('baseurl-save');
const baseUrlDirty = initDirtyNote($baseUrlForm, document.getElementById('baseurl-dirty'), $baseUrlNote);

function applyBaseUrl(s) {
  const input = $baseUrlForm.elements.namedItem('base_url');
  input.value = s.base_url ?? '';
  const fromEnv = s.base_url_source === 'env';
  input.disabled = fromEnv;
  $baseUrlSave.disabled = fromEnv;
  $baseUrlStatus.textContent = fromEnv
    ? 'Set by the FLATLINE_BASE_URL environment variable — unset it to edit here.'
    : s.base_url
      ? 'Notifications link back to this address.'
      : 'Not set — notifications carry no link.';
  baseUrlDirty.markClean();
}

$baseUrlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    $baseUrlError.textContent = '';
    $baseUrlNote.textContent = '';
    try {
      applyBaseUrl(await putSettings({ base_url: $baseUrlForm.elements.namedItem('base_url').value }));
      $baseUrlNote.textContent = 'Saved ✓';
      setTimeout(() => { $baseUrlNote.textContent = ''; }, 2500);
    } catch (err) {
      $baseUrlError.textContent = err.message;
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
const passwordDirty = initDirtyNote($passwordForm, document.getElementById('password-dirty'), $passwordNote);
const hostsDirty = initDirtyNote($hostsForm, document.getElementById('hosts-dirty'), $hostsNote);

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
    const ok = await confirmDialog({
      title: 'Save site password?',
      body: [
        'This password will be required to reach Flatline\'s UI and API.',
        'Any other active sessions will be signed out.'
      ],
      confirmText: 'Save password'
    });
    if (!ok) return;
    try {
      const result = await setSitePassword(pw);
      $passwordForm.reset();
      passwordDirty.markClean();
      $passwordNote.textContent = `✓ ${result.note}`;
      await refreshSecurity();
    } catch (err) {
      $passwordError.textContent = err.message;
    }
  })();
});

$passwordRemove.addEventListener('click', () => {
  void (async () => {
    const ok = await confirmDialog({
      title: 'Remove the site password?',
      body: '!WARNING! Flatline\'s UI and API will be open to anyone who can reach this URL or IP:Port.',
      confirmText: 'Remove password',
      danger: true
    });
    if (!ok) return;
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
      hostsDirty.markClean();
      $hostsNote.textContent = 'Saved ✓';
      setTimeout(() => { $hostsNote.textContent = ''; }, 2500);
    } catch (err) {
      $hostsError.textContent = err.message;
    }
  })();
});

// ---------- backup & restore ----------

const $configExport = document.getElementById('config-export');
const $configImportBtn = document.getElementById('config-import-btn');
const $configImport = document.getElementById('config-import');
const $configNote = document.getElementById('config-transfer-note');
const $configError = document.getElementById('config-transfer-error');
const $dbBackup = document.getElementById('db-backup');
const $dbRestoreBtn = document.getElementById('db-restore-btn');
const $dbRestore = document.getElementById('db-restore');
const $appReset = document.getElementById('app-reset');
const $dbNote = document.getElementById('db-transfer-note');
const $dbError = document.getElementById('db-transfer-error');

/** yyyymmdd-hhmmss for download filenames. */
function tsSlug() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Triggers a browser download of a Blob — nothing is written server-side. */
function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$configExport.addEventListener('click', () => {
  void (async () => {
    $configError.textContent = '';
    $configNote.textContent = 'Preparing export…';
    try {
      const data = await exportConfig();
      saveBlob(`flatline-config-${tsSlug()}.json`,
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      $configNote.textContent = 'Exported ✓';
    } catch (err) {
      $configNote.textContent = '';
      $configError.textContent = err.message;
    }
  })();
});

$configImportBtn.addEventListener('click', () => $configImport.click());
$configImport.addEventListener('change', () => {
  const file = $configImport.files[0];
  $configImport.value = '';
  if (!file) return;
  void (async () => {
    $configError.textContent = '';
    $configNote.textContent = '';
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      $configError.textContent = 'that file is not valid JSON';
      return;
    }
    const ok = await confirmDialog({
      title: 'Import configuration?',
      body: [
        'This REPLACES all current endpoints, Flatline groups, action targets, action groups, and notification channels with the file’s contents.',
        'Encrypted credentials import as-is and only work if this instance uses the same encryption key. This can’t be undone.'
      ],
      confirmText: 'Replace configuration',
      danger: true
    });
    if (!ok) return;
    try {
      await importConfig(data);
      $configNote.textContent = 'Configuration imported ✓';
      await refreshChannels();
      await loadSettings();
      await refreshKeyStatus();
      await refreshSecurity();
    } catch (err) {
      $configError.textContent = err.message;
    }
  })();
});

$dbBackup.addEventListener('click', () => {
  void (async () => {
    $dbError.textContent = '';
    $dbNote.textContent = 'Preparing backup…';
    try {
      const blob = await downloadBackup();
      saveBlob(`flatline-backup-${tsSlug()}.db`, blob);
      $dbNote.textContent = 'Backup downloaded ✓';
    } catch (err) {
      $dbNote.textContent = '';
      $dbError.textContent = err.message;
    }
  })();
});

$dbRestoreBtn.addEventListener('click', () => $dbRestore.click());
$dbRestore.addEventListener('change', () => {
  const file = $dbRestore.files[0];
  $dbRestore.value = '';
  if (!file) return;
  void (async () => {
    $dbError.textContent = '';
    $dbNote.textContent = '';
    const ok = await confirmDialog({
      title: 'Restore database?',
      body: [
        'This OVERWRITES the entire database (configuration and all history) with the uploaded file.',
        'Stored credentials work only if this instance uses the same encryption key as the backup. This can’t be undone.'
      ],
      confirmText: 'Overwrite database',
      danger: true
    });
    if (!ok) return;
    try {
      await restoreBackup(file);
      $dbNote.textContent = 'Database restored ✓';
      await refreshChannels();
      await loadRelays();
      await loadSettings();
      await refreshKeyStatus();
      await refreshSecurity();
    } catch (err) {
      $dbError.textContent = err.message;
    }
  })();
});

$appReset.addEventListener('click', () => {
  void (async () => {
    $dbError.textContent = '';
    $dbNote.textContent = '';
    const ok = await confirmDialog({
      title: 'Reset Flatline to a clean start?',
      body: [
        'This PERMANENTLY deletes ALL endpoints, Flatline groups, action targets, action groups, notification channels, and all history.',
        'It also removes the site password (login turns OFF and the UI/API become open to anyone who can reach this port) and clears allowed hosts and settings. The encryption key is kept.',
        'This cannot be undone.'
      ],
      confirmText: 'Reset everything',
      danger: true
    });
    if (!ok) return;
    try {
      await resetApp();
      $dbNote.textContent = 'Flatline reset to a clean start ✓';
      await refreshChannels();
      await loadRelays();
      await loadSettings();
      await refreshKeyStatus();
      await refreshSecurity();
    } catch (err) {
      $dbError.textContent = err.message;
    }
  })();
});

// ---------- boot ----------

channelForm.toAddMode();
relayForm.toAddMode();

const snapshot = loadSnapshot('config');
if (snapshot) {
  ({ channels, relays } = snapshot);
  renderChannelTable();
  renderRelayTable();
}
saveSnapshotOnExit('config', () => (channelsLoaded && relaysLoaded ? { channels, relays } : null));

void refreshChannels();
void loadRelays();
void loadSettings();
void refreshKeyStatus();
void refreshSecurity();

setInterval(() => void refreshChannels(), 20_000);
