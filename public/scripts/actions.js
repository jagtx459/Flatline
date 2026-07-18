import {
  listActionTargets, createActionTarget, updateActionTarget, deleteActionTarget, testActionTarget, runActionTarget,
  restoreActionTarget,
  listActionGroups, createActionGroup, updateActionGroup, deleteActionGroup,
  listGroups, updateGroup
} from './api.js';
import { el, clear, fmtDateTime, enabledPill, initCollapsible } from './dom.js';
import { initHeaderAuth } from './header.js';

initHeaderAuth();

let targets = [];
let igroups = [];
let flatlineGroups = [];

const KIND_LABELS = { ssh: 'SSH', winrm: 'WinRM', k8s: 'Kubernetes', http: 'HTTP(S)' };
const K8S_ACTION_LABELS = { drain: 'cordon + drain all nodes', custom: 'custom command' };

// Shown in the Restore confirm dialog — what "undo" actually means per kind.
const RESTORE_HINTS = {
  ssh: 'This runs the configured restore command over SSH.',
  winrm: 'This runs the configured restore command over WinRM.',
  http: 'This sends the configured restore request.',
  k8s: 'For "cordon + drain" this uncordons every node. For a custom command, it runs the configured restore request.'
};

// Maps a kind's secret field -> form input name.
const SECRET_INPUTS = {
  ssh:  { password: 'ssh_password', private_key: 'ssh_private_key', passphrase: 'ssh_passphrase', sudo_password: 'ssh_sudo_password' },
  winrm: { password: 'winrm_password' },
  k8s:  { token: 'k8s_token', kubeconfig: 'k8s_kubeconfig' },
  http: { token: 'http_token', password: 'http_password' }
};

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
  $formTestResult.textContent = '';
}

function syncHttpAuthFields() {
  const scheme = $httpScheme.value;
  for (const node of $form.querySelectorAll('[data-http]')) {
    const schemes = node.dataset.http.split(' ');
    node.style.display = schemes.includes(scheme) ? '' : 'none';
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
$sshAuthMethod.addEventListener('change', syncSshAuthFields);
$k8sAuthMethod.addEventListener('change', syncK8sAuthFields);
$k8sAction.addEventListener('change', syncK8sActionFields);

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
  switch (kind) {
    case 'ssh': return {
      host: field('ssh_host').value,
      port: Number(field('ssh_port').value) || 22,
      username: field('ssh_username').value,
      auth_method: field('ssh_auth_method').value,
      command: field('ssh_command').value,
      restore_command: field('ssh_restore_command').value
    };
    case 'winrm': return {
      host: field('winrm_host').value,
      port: Number(field('winrm_port').value) || 5985,
      domain: field('winrm_domain').value,
      username: field('winrm_username').value,
      command: field('winrm_command').value,
      restore_command: field('winrm_restore_command').value
    };
    case 'k8s': return {
      api_url: field('k8s_api_url').value,
      auth_method: field('k8s_auth_method').value,
      action: field('k8s_action').value,
      command_method: field('k8s_command_method').value,
      command_path: field('k8s_command_path').value,
      command_body: field('k8s_command_body').value,
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
      field('ssh_restore_command').value = c.restore_command ?? '';
      break;
    case 'winrm':
      field('winrm_host').value = c.host ?? '';
      field('winrm_port').value = String(c.port ?? 5985);
      field('winrm_domain').value = c.domain ?? '';
      field('winrm_username').value = c.username ?? '';
      field('winrm_command').value = c.command ?? '';
      field('winrm_restore_command').value = c.restore_command ?? '';
      break;
    case 'k8s':
      field('k8s_api_url').value = c.api_url ?? '';
      field('k8s_auth_method').value = c.auth_method ?? 'token';
      field('k8s_action').value = c.action ?? 'drain';
      field('k8s_command_method').value = c.command_method ?? 'PATCH';
      field('k8s_command_path').value = c.command_path ?? '';
      field('k8s_command_body').value = c.command_body ?? '';
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
    $formTestResult.textContent = kind === 'http' ? 'Sending test request…' : 'Testing…';
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
        if (!confirm(`Delete target "${t.name}" and its stored credentials?`)) return;
        await deleteActionTarget(t.id);
        if (editingTargetId === t.id) resetTargetForm();
        await refreshAll();
      })();
    });

    const runBtn = el('button', { class: 'btn danger-soft small' }, 'Run');
    runBtn.addEventListener('click', () => {
      void (async () => {
        const verb = t.kind === 'http' ? 'Send the real request configured for' : 'Run the command/action configured for';
        if (!confirm(`${verb} "${t.name}" right now?\n\nThis performs the ACTUAL action — be careful in production environments.`)) return;
        runBtn.disabled = true;
        try {
          const result = await runActionTarget(t.id);
          alert(`${result.ok ? '✓ succeeded' : '✕ failed'}: ${result.message}`);
        } catch (err) {
          alert(`Error: ${err.message}`);
        } finally {
          await refreshAll();
        }
      })();
    });

    const restoreBtn = el('button', { class: 'btn ghost small' }, 'Restore');
    const hasRestore = t.kind === 'k8s'
      || (t.kind === 'ssh' && !!t.config.restore_command)
      || (t.kind === 'winrm' && !!t.config.restore_command)
      || (t.kind === 'http' && !!t.config.restore_url);
    if (!hasRestore) {
      restoreBtn.disabled = true;
      restoreBtn.title = 'No restore command configured for this target — add one in the edit form';
    } else {
      restoreBtn.addEventListener('click', () => {
        void (async () => {
          if (!confirm(`Undo/restore "${t.name}" right now?\n\n${RESTORE_HINTS[t.kind] ?? ''}`)) return;
          restoreBtn.disabled = true;
          try {
            const result = await restoreActionTarget(t.id);
            alert(`${result.ok ? '✓ succeeded' : '✕ failed'}: ${result.message}`);
          } catch (err) {
            alert(`Error: ${err.message}`);
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

// ---------- action groups (ordered steps) ----------

const $igForm = document.getElementById('igroup-form');
const $igFormTitle = document.getElementById('igroup-form-title');
const $igError = document.getElementById('igroup-error');
const $igSubmit = document.getElementById('igroup-submit');
const $igCancel = document.getElementById('igroup-cancel');
const $igReset = document.getElementById('igroup-reset');
const $igSaveNote = document.getElementById('igroup-save-note');
const $igTable = document.getElementById('igroup-table');
const $stepList = document.getElementById('step-list');
const $stepSelect = document.getElementById('step-target-select');
const $stepAddBtn = document.getElementById('step-add-btn');
const $igFlatlineGroupChecks = document.getElementById('ig-flatline-group-checks');
const igroupFormSection = initCollapsible('actions:igroup-form',
  document.getElementById('igroup-form-header'), document.getElementById('igroup-form-body'));

let editingIgId = null;
/** Ordered steps being edited: [{ target_id, timeout_seconds }] */
let steps = [];

function renderStepSelect() {
  clear($stepSelect);
  const used = new Set(steps.map((s) => s.target_id));
  const available = targets.filter((t) => !used.has(t.id));
  if (available.length === 0) {
    $stepSelect.append(el('option', { value: '' },
      targets.length === 0 ? 'no targets defined yet' : 'all targets already in the sequence'));
    $stepSelect.disabled = true;
    $stepAddBtn.disabled = true;
    return;
  }
  $stepSelect.disabled = false;
  $stepAddBtn.disabled = false;
  for (const t of available) {
    $stepSelect.append(el('option', { value: String(t.id) }, `${t.name} (${KIND_LABELS[t.kind] ?? t.kind})`));
  }
}

function renderStepList() {
  clear($stepList);
  if (steps.length === 0) {
    $stepList.append(el('div', { class: 'hint-row', style: 'margin:6px 0' },
      'No steps yet — pick a target below and add it. Steps run top to bottom.'));
  }

  steps.forEach((step, i) => {
    const t = targetById(step.target_id);

    const timeout = el('input', {
      type: 'number', min: '5', max: '3600', value: String(step.timeout_seconds),
      class: 'step-timeout', title: 'Step timeout (seconds)'
    });
    timeout.addEventListener('change', () => {
      step.timeout_seconds = Math.min(3600, Math.max(5, Number(timeout.value) || 60));
      timeout.value = String(step.timeout_seconds);
    });

    const up = el('button', { type: 'button', class: 'btn ghost small', title: 'Move up' }, '↑');
    up.disabled = i === 0;
    up.addEventListener('click', () => {
      [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
      renderSteps();
    });

    const down = el('button', { type: 'button', class: 'btn ghost small', title: 'Move down' }, '↓');
    down.disabled = i === steps.length - 1;
    down.addEventListener('click', () => {
      [steps[i], steps[i + 1]] = [steps[i + 1], steps[i]];
      renderSteps();
    });

    const remove = el('button', { type: 'button', class: 'btn danger-ghost small', title: 'Remove step' }, '✕');
    remove.addEventListener('click', () => {
      steps.splice(i, 1);
      renderSteps();
    });

    $stepList.append(el('div', { class: 'step-row' },
      el('span', { class: 'step-num' }, `${i + 1}.`),
      el('span', { class: 'step-name' },
        t ? t.name : `(deleted target ${step.target_id})`,
        t ? el('span', { class: 'hint' }, ` (${KIND_LABELS[t.kind] ?? t.kind})`) : null),
      el('span', { class: 'step-timeout-wrap' }, timeout, el('span', { class: 'hint' }, 's timeout')),
      el('span', { class: 'step-btns' }, up, down, remove)
    ));
  });
}

function renderSteps() {
  renderStepList();
  renderStepSelect();
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

$stepAddBtn.addEventListener('click', () => {
  const id = Number($stepSelect.value);
  if (!id) return;
  steps.push({ target_id: id, timeout_seconds: 60 });
  renderSteps();
});

function resetIgForm() {
  editingIgId = null;
  steps = [];
  $igForm.reset();
  $igFormTitle.textContent = 'Add action group';
  $igSubmit.textContent = 'Add group';
  $igCancel.style.display = 'none';
  $igReset.style.display = '';
  $igError.textContent = '';
  $igSaveNote.textContent = '';
  renderSteps();
  renderIgFlatlineGroupChecks();
}

function fillIgForm(g) {
  editingIgId = g.id;
  steps = g.steps.map((s) => ({ ...s }));
  $igForm.elements.namedItem('name').value = g.name;
  $igForm.elements.namedItem('on_failure').value = g.on_failure;
  $igForm.elements.namedItem('enabled').checked = !!g.enabled;
  renderSteps();
  const assignedIds = flatlineGroups.filter((fg) => fg.action_group_ids.includes(g.id)).map((fg) => fg.id);
  renderIgFlatlineGroupChecks(assignedIds);
  $igFormTitle.textContent = `Edit group: ${g.name}`;
  $igSubmit.textContent = 'Save changes';
  $igCancel.style.display = '';
  $igReset.style.display = 'none';
  $igError.textContent = '';
  $igSaveNote.textContent = '';
  igroupFormSection.expand();
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
      steps
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
        if (!confirm(`Delete action group "${g.name}"? Its targets are kept.`)) return;
        await deleteActionGroup(g.id);
        if (editingIgId === g.id) resetIgForm();
        await refreshAll();
      })();
    });

    const stepText = g.steps.length
      ? g.steps.map((s, i) => `${i + 1}. ${targetById(s.target_id)?.name ?? '?'}`).join('  →  ')
      : '—';

    tbody.append(el('tr', {},
      el('td', {}, enabledPill(g.enabled)),
      el('td', {}, el('strong', {}, g.name)),
      el('td', { class: 'target-cell', title: stepText }, stepText),
      el('td', {}, g.on_failure === 'stop' ? 'stop sequence' : 'continue'),
      el('td', { class: 'mono' }, `${g.assigned_count} Flatline group(s)`),
      el('td', {}, el('span', { style: 'display:inline-flex;gap:6px' }, editBtn, delBtn))
    ));
  }

  const table = el('table', { class: 'endpoints' });
  table.append(
    el('thead', {}, el('tr', {},
      el('th', {}, 'Status'), el('th', {}, 'Group'), el('th', {}, 'Steps (in order)'), el('th', {}, 'On step failure'),
      el('th', {}, 'Assigned to'), el('th', {}, ''))),
    tbody
  );
  $igTable.append(table);
}

// ---------- boot ----------

async function refreshAll() {
  [targets, igroups, flatlineGroups] = await Promise.all([listActionTargets(), listActionGroups(), listGroups()]);
  renderTargetTable();
  renderIgTable();
  renderSteps();
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
