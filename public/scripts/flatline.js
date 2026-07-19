import {
  listEndpoints, createEndpoint, updateEndpoint, deleteEndpoint, testEndpoint,
  listGroups, createGroup, updateGroup, deleteGroup,
  listActionGroups
} from './api.js';
import { el, clear, enabledPill, initCollapsible } from './dom.js';
import { initHeaderAuth } from './header.js';

initHeaderAuth();

let groups = [];
let actionGroups = [];
let endpoints = [];

// ---------- Flatline groups ----------

const $groupForm = document.getElementById('group-form');
const $groupFormTitle = document.getElementById('group-form-title');
const $groupError = document.getElementById('group-error');
const $groupSubmit = document.getElementById('group-submit');
const $groupCancel = document.getElementById('group-cancel');
const $groupReset = document.getElementById('group-reset');
const $groupSaveNote = document.getElementById('group-save-note');
const $groupEndpointChecks = document.getElementById('group-endpoint-checks');
const $groupTable = document.getElementById('group-table');
const groupFormSection = initCollapsible('flatline:group-form',
  document.getElementById('group-form-header'), document.getElementById('group-form-body'));

let editingGroupId = null;
/** action_group_ids of the group being edited — preserved as-is since that
 *  assignment is now managed from the Actions page, not this form. */
let editingGroupActionIds = [];

function gField(name) {
  return $groupForm.elements.namedItem(name);
}

function renderGroupEndpointChecks(selectedIds = []) {
  clear($groupEndpointChecks);
  if (endpoints.length === 0) {
    $groupEndpointChecks.append(el('span', { class: 'hint-row' }, 'Add an endpoint first (form above).'));
    return;
  }
  for (const ep of endpoints) {
    const cb = el('input', { type: 'checkbox', value: String(ep.id) });
    cb.checked = selectedIds.includes(ep.id);
    cb.dataset.endpoint = '1';
    const otherNames = ep.group_names.filter((_, i) => ep.group_ids[i] !== editingGroupId);
    $groupEndpointChecks.append(el('label', { class: 'check' }, cb,
      el('span', {}, ep.name),
      otherNames.length ? el('span', { class: 'hint' }, `(also in ${otherNames.join(', ')})`) : null));
  }
}

function selectedEndpointIds() {
  return [...$groupEndpointChecks.querySelectorAll('input[data-endpoint]')]
    .filter((cb) => cb.checked)
    .map((cb) => Number(cb.value));
}

function resetGroupForm() {
  editingGroupId = null;
  editingGroupActionIds = [];
  $groupForm.reset();
  $groupFormTitle.textContent = 'Add Flatline group';
  $groupSubmit.textContent = 'Add group';
  $groupCancel.style.display = 'none';
  $groupReset.style.display = '';
  $groupError.textContent = '';
  $groupSaveNote.textContent = '';
  renderGroupEndpointChecks();
}

function fillGroupForm(g) {
  editingGroupId = g.id;
  editingGroupActionIds = g.action_group_ids ?? [];
  gField('name').value = g.name;
  gField('mode').value = g.mode;
  gField('grace_minutes').value = String(g.grace_minutes);
  gField('enabled').checked = !!g.enabled;
  renderGroupEndpointChecks(g.endpoint_ids);
  $groupFormTitle.textContent = `Edit group: ${g.name}`;
  $groupSubmit.textContent = 'Save changes';
  $groupCancel.style.display = '';
  $groupReset.style.display = 'none';
  $groupError.textContent = '';
  $groupSaveNote.textContent = '';
  groupFormSection.expand();
  $groupForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$groupCancel.addEventListener('click', (e) => {
  e.preventDefault();
  resetGroupForm();
});

$groupReset.addEventListener('click', () => resetGroupForm());

$groupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const input = {
      name: gField('name').value,
      mode: gField('mode').value,
      grace_minutes: Number(gField('grace_minutes').value),
      enabled: gField('enabled').checked,
      action_group_ids: editingGroupActionIds,
      endpoint_ids: selectedEndpointIds()
    };
    const wasEditing = editingGroupId != null;
    try {
      const saved = wasEditing ? await updateGroup(editingGroupId, input) : await createGroup(input);
      $groupError.textContent = '';
      await refreshAll();
      if (wasEditing) {
        fillGroupForm(groups.find((g) => g.id === saved.id) ?? saved);
        $groupSaveNote.textContent = 'Saved ✓';
      } else {
        resetGroupForm();
      }
    } catch (err) {
      $groupError.textContent = err.message;
    }
  })();
});

function renderGroupTable() {
  clear($groupTable);
  if (groups.length === 0) {
    $groupTable.append(el('div', { class: 'empty' },
      'No Flatline groups yet. Endpoints can be monitored without one, but only grouped endpoints can trigger actions.'));
    return;
  }

  const tbody = el('tbody', {});
  for (const g of groups) {
    const editBtn = el('button', { class: 'btn ghost small' }, 'Edit');
    editBtn.addEventListener('click', () => fillGroupForm(g));
    const delBtn = el('button', { class: 'btn danger-ghost small' }, 'Delete');
    delBtn.addEventListener('click', () => {
      void (async () => {
        if (!confirm(`Delete group "${g.name}"? Its endpoints stay, but become ungrouped.`)) return;
        await deleteGroup(g.id);
        if (editingGroupId === g.id) resetGroupForm();
        await refreshAll();
      })();
    });

    const epNames = g.endpoint_ids
      .map((id) => endpoints.find((e) => e.id === id)?.name)
      .filter(Boolean);
    const agNames = g.action_group_ids
      .map((id) => actionGroups.find((ag) => ag.id === id)?.name)
      .filter(Boolean);

    tbody.append(el('tr', {},
      el('td', {}, enabledPill(g.enabled)),
      el('td', {}, el('strong', {}, g.name)),
      el('td', {}, g.mode === 'all' ? 'all down' : 'any down'),
      el('td', { class: 'mono' }, `${g.grace_minutes} min`),
      el('td', { class: 'target-cell', title: epNames.join(', ') }, epNames.length ? epNames.join(', ') : '—'),
      el('td', {}, agNames.length ? agNames.join(', ') : '—'),
      el('td', {}, el('span', { style: 'display:inline-flex;gap:6px' }, editBtn, delBtn))
    ));
  }

  const table = el('table', { class: 'endpoints' });
  table.append(
    el('thead', {}, el('tr', {},
      el('th', {}, 'Status'), el('th', {}, 'Group'), el('th', {}, 'Fails when'), el('th', {}, 'Grace'),
      el('th', {}, 'Endpoints'), el('th', {}, 'Runs actions'), el('th', {}, ''))),
    tbody
  );
  $groupTable.append(table);
}

// ---------- Flatline endpoints ----------

const $form = document.getElementById('endpoint-form');
const $formTitle = document.getElementById('form-title');
const $formError = document.getElementById('form-error');
const $formSubmit = document.getElementById('form-submit');
const $formCancel = document.getElementById('form-cancel');
const $formReset = document.getElementById('form-reset');
const $formTest = document.getElementById('form-test');
const $formTestResult = document.getElementById('form-test-result');
const $formSaveNote = document.getElementById('form-save-note');
const $table = document.getElementById('endpoint-table');
const $typeSelect = document.getElementById('f-type');
const $httpFields = document.getElementById('http-fields');
const endpointFormSection = initCollapsible('flatline:endpoint-form',
  document.getElementById('form-header'), document.getElementById('form-body'));

let editingId = null;

function syncTypeFields() {
  $httpFields.style.display = $typeSelect.value === 'http' ? '' : 'none';
}
$typeSelect.addEventListener('change', syncTypeFields);

function field(name) {
  return $form.elements.namedItem(name);
}

function collectEndpointInput() {
  return {
    name: field('name').value,
    type: $typeSelect.value,
    target: field('target').value,
    interval_seconds: Number(field('interval_seconds').value),
    timeout_ms: Number(field('timeout_ms').value),
    down_threshold: Number(field('down_threshold').value),
    up_threshold: Number(field('up_threshold').value),
    expect_status: field('expect_status').value || null,
    expect_json: field('expect_json').value.trim() || null,
    enabled: field('enabled').checked
  };
}

function resetForm() {
  editingId = null;
  $form.reset();
  $formTitle.textContent = 'Add Flatline endpoint';
  $formSubmit.textContent = 'Add endpoint';
  $formCancel.style.display = 'none';
  $formReset.style.display = '';
  $formError.textContent = '';
  $formTestResult.textContent = '';
  $formSaveNote.textContent = '';
  syncTypeFields();
}

function fillForm(ep) {
  editingId = ep.id;
  field('name').value = ep.name;
  $typeSelect.value = ep.type;
  field('target').value = ep.target;
  field('interval_seconds').value = String(ep.interval_seconds);
  field('timeout_ms').value = String(ep.timeout_ms);
  field('down_threshold').value = String(ep.down_threshold);
  field('up_threshold').value = String(ep.up_threshold);
  field('expect_status').value = ep.expect_status == null ? '' : String(ep.expect_status);
  field('expect_json').value = ep.expect_json ?? '';
  field('enabled').checked = !!ep.enabled;
  $formTitle.textContent = `Edit: ${ep.name}`;
  $formSubmit.textContent = 'Save changes';
  $formCancel.style.display = '';
  $formReset.style.display = 'none';
  $formError.textContent = '';
  $formTestResult.textContent = '';
  $formSaveNote.textContent = '';
  syncTypeFields();
  endpointFormSection.expand();
  $form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$formCancel.addEventListener('click', (e) => {
  e.preventDefault();
  resetForm();
});

$formReset.addEventListener('click', () => resetForm());

$form.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const input = collectEndpointInput();
    const wasEditing = editingId != null;
    try {
      const saved = wasEditing ? await updateEndpoint(editingId, input) : await createEndpoint(input);
      $formError.textContent = '';
      await refreshAll();
      if (wasEditing) {
        fillForm(endpoints.find((e) => e.id === saved.id) ?? saved);
        $formSaveNote.textContent = 'Saved ✓';
      } else {
        resetForm();
      }
    } catch (err) {
      $formError.textContent = err.message;
    }
  })();
});

$formTest.addEventListener('click', () => {
  void (async () => {
    $formTestResult.className = 'note';
    $formTestResult.textContent = 'Testing…';
    $formError.textContent = '';
    try {
      const result = await testEndpoint(collectEndpointInput());
      $formTestResult.className = result.ok ? 'note' : 'error';
      $formTestResult.textContent = result.ok
        ? `✓ up${result.latencyMs != null ? ` (${Math.round(result.latencyMs)} ms)` : ''}`
        : `✕ ${result.error ?? 'down'}`;
    } catch (err) {
      $formTestResult.className = 'error';
      $formTestResult.textContent = err.message;
    }
  })();
});

function endpointCheckSummary(ep) {
  if (ep.type === 'icmp') return 'ping';
  const parts = ['http'];
  if (ep.expect_status) parts.push(`status ${ep.expect_status}`);
  if (ep.expect_json) parts.push('JSON match');
  return parts.join(' · ');
}

function renderEndpointTable() {
  clear($table);

  if (endpoints.length === 0) {
    $table.append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, 'No endpoints configured'),
      el('div', {}, 'Add the router, UPS, or service you want to watch using the endpoint form below.')
    ));
    return;
  }

  const tbody = el('tbody', {});
  for (const ep of endpoints) {
    const pillCls = !ep.enabled ? 'disabled' : ep.last_state === 'up' ? 'up' : ep.last_state === 'down' ? 'down' : 'unknown';
    const pillText = !ep.enabled ? 'DISABLED' : ep.last_state === 'up' ? 'UP' : ep.last_state === 'down' ? 'DOWN' : 'PENDING';

    const editBtn = el('button', { class: 'btn ghost small' }, 'Edit');
    editBtn.addEventListener('click', () => fillForm(ep));
    const delBtn = el('button', { class: 'btn danger-ghost small' }, 'Delete');
    delBtn.addEventListener('click', () => {
      void (async () => {
        if (!confirm(`Delete "${ep.name}" and all of its history?`)) return;
        await deleteEndpoint(ep.id);
        if (editingId === ep.id) resetForm();
        await refreshAll();
      })();
    });

    tbody.append(el('tr', {},
      el('td', {}, el('span', { class: `pill ${pillCls}` }, el('span', { class: 'dot' }), pillText)),
      el('td', {}, el('strong', {}, ep.name)),
      el('td', {}, endpointCheckSummary(ep)),
      el('td', { class: 'target-cell', title: ep.target }, ep.target),
      el('td', { class: 'mono' }, `${ep.interval_seconds}s`),
      el('td', {}, ep.group_names.length ? ep.group_names.join(', ') : '—'),
      el('td', {}, el('span', { style: 'display:inline-flex;gap:6px' }, editBtn, delBtn))
    ));
  }

  const table = el('table', { class: 'endpoints' });
  table.append(
    el('thead', {}, el('tr', {},
      el('th', {}, 'Status'), el('th', {}, 'Name'), el('th', {}, 'Check'),
      el('th', {}, 'Target'), el('th', {}, 'Interval'), el('th', {}, 'Group'), el('th', {}, ''))),
    tbody
  );
  $table.append(table);
}

// ---------- boot ----------

async function refreshAll() {
  [groups, actionGroups, endpoints] = await Promise.all([listGroups(), listActionGroups(), listEndpoints()]);
  renderGroupTable();
  renderEndpointTable();
  // Keep form selection valid without clobbering an in-progress edit.
  if (editingGroupId == null) {
    renderGroupEndpointChecks(selectedEndpointIds());
  }
}

resetGroupForm();
resetForm();
void refreshAll();
