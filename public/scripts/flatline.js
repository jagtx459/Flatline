import { endpoints as endpointsApi, groups as groupsApi, actionGroups } from './api.js';
import { el, clear, enabledPill, initCollapsible, initDirtyNote, initHelp } from './dom.js';
import { initEntityForm, renderTable, editDeleteButtons, actionsCell } from './crud.js';
import { initHeaderAuth } from './header.js';
import { loadSnapshot, saveSnapshotOnExit } from './snapshot.js';
import { watchBanners } from './banners.js';

initHeaderAuth();
initHelp();
watchBanners();

let groups = [];
let actionGroupList = [];
let endpoints = [];
let loaded = false; // true once the live lists have arrived at least once

// ---------- Flatline groups ----------

const $groupForm = document.getElementById('group-form');
const $groupEndpointChecks = document.getElementById('group-endpoint-checks');
const $groupTable = document.getElementById('group-table');
const groupFormSection = initCollapsible('flatline:group-form',
  document.getElementById('group-form-header'), document.getElementById('group-form-body'));
const groupDirty = initDirtyNote($groupForm, document.getElementById('group-dirty'),
  document.getElementById('group-save-note'));

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
    const otherNames = ep.group_names.filter((_, i) => ep.group_ids[i] !== groupForm.editingId);
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

const groupForm = initEntityForm({
  form: $groupForm,
  els: {
    title: document.getElementById('group-form-title'),
    error: document.getElementById('group-error'),
    submit: document.getElementById('group-submit'),
    cancel: document.getElementById('group-cancel'),
    reset: document.getElementById('group-reset'),
    saveNote: document.getElementById('group-save-note')
  },
  section: groupFormSection,
  siblingSection: () => endpointFormSection,
  dirty: groupDirty,
  noun: 'Flatline group',
  itemLabel: 'group',
  api: groupsApi,
  reset: () => {
    editingGroupActionIds = [];
    renderGroupEndpointChecks();
  },
  fill: (g) => {
    editingGroupActionIds = g.action_group_ids ?? [];
    gField('name').value = g.name;
    gField('mode').value = g.mode;
    gField('grace_minutes').value = String(g.grace_minutes);
    gField('enabled').checked = !!g.enabled;
    renderGroupEndpointChecks(g.endpoint_ids);
  },
  collect: () => ({
    name: gField('name').value,
    mode: gField('mode').value,
    grace_minutes: Number(gField('grace_minutes').value),
    enabled: gField('enabled').checked,
    action_group_ids: editingGroupActionIds,
    endpoint_ids: selectedEndpointIds()
  }),
  findSaved: (id) => groups.find((g) => g.id === id),
  refresh: refreshAll
});

function renderGroupTable() {
  renderTable($groupTable, {
    headers: ['Status', 'Group', 'Fails when', 'Grace', 'Endpoints', 'Runs actions', ''],
    rows: groups,
    empty: 'No Flatline groups yet. Endpoints can be monitored without one, but only grouped endpoints can trigger actions.',
    cells: (g) => {
      const epNames = g.endpoint_ids
        .map((id) => endpoints.find((e) => e.id === id)?.name)
        .filter(Boolean);
      const agNames = g.action_group_ids
        .map((id) => actionGroupList.find((ag) => ag.id === id)?.name)
        .filter(Boolean);

      return [
        el('td', {}, enabledPill(g.enabled)),
        el('td', {}, el('strong', {}, g.name)),
        el('td', {}, g.mode === 'all' ? 'all down' : 'any down'),
        el('td', { class: 'mono' }, `${g.grace_minutes} min`),
        el('td', { class: 'target-cell', title: epNames.join(', ') }, epNames.length ? epNames.join(', ') : '—'),
        el('td', {}, agNames.length ? agNames.join(', ') : '—'),
        actionsCell(editDeleteButtons({
          onEdit: () => groupForm.toEditMode(g),
          confirm: {
            title: 'Delete Flatline group?',
            body: `"${g.name}" will be deleted. Its endpoints keep running — they just stop belonging to this group and can no longer trigger its actions.`,
            confirmText: 'Delete group'
          },
          onDelete: async () => {
            await groupsApi.remove(g.id);
            groupForm.forgetIfEditing(g.id);
            await refreshAll();
          }
        }))
      ];
    }
  });
}

// ---------- Flatline endpoints ----------

const $form = document.getElementById('endpoint-form');
const $formTestResult = document.getElementById('form-test-result');
const $formError = document.getElementById('form-error');
const $table = document.getElementById('endpoint-table');
const $typeSelect = document.getElementById('f-type');
const $httpFields = document.getElementById('http-fields');
const endpointFormSection = initCollapsible('flatline:endpoint-form',
  document.getElementById('form-header'), document.getElementById('form-body'));
const formDirty = initDirtyNote($form, document.getElementById('form-dirty'),
  document.getElementById('form-save-note'));

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

const endpointForm = initEntityForm({
  form: $form,
  els: {
    title: document.getElementById('form-title'),
    error: $formError,
    submit: document.getElementById('form-submit'),
    cancel: document.getElementById('form-cancel'),
    reset: document.getElementById('form-reset'),
    saveNote: document.getElementById('form-save-note'),
    testResult: $formTestResult
  },
  section: endpointFormSection,
  siblingSection: () => groupFormSection,
  dirty: formDirty,
  noun: 'Flatline endpoint',
  itemLabel: 'endpoint',
  // This form's edit heading is just "Edit: NAME" — it is the page's primary
  // form and the extra words crowd it.
  editLabel: '',
  api: endpointsApi,
  reset: syncTypeFields,
  fill: (ep) => {
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
    syncTypeFields();
  },
  collect: collectEndpointInput,
  findSaved: (id) => endpoints.find((e) => e.id === id),
  refresh: refreshAll
});

document.getElementById('form-test').addEventListener('click', () => {
  void (async () => {
    $formTestResult.className = 'note';
    $formTestResult.textContent = 'Testing…';
    $formError.textContent = '';
    try {
      const result = await endpointsApi.test(collectEndpointInput());
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
  renderTable($table, {
    headers: ['Status', 'Name', 'Check', 'Target', 'Interval', 'Group', ''],
    rows: endpoints,
    empty: ['No endpoints configured',
      'Add the router, UPS, or service you want to watch using the endpoint form below.'],
    cells: (ep) => {
      const pillCls = !ep.enabled ? 'disabled' : ep.last_state === 'up' ? 'up' : ep.last_state === 'down' ? 'down' : 'unknown';
      const pillText = !ep.enabled ? 'DISABLED' : ep.last_state === 'up' ? 'UP' : ep.last_state === 'down' ? 'DOWN' : 'PENDING';

      return [
        el('td', {}, el('span', { class: `pill ${pillCls}` }, el('span', { class: 'dot' }), pillText)),
        el('td', {}, el('strong', {}, ep.name)),
        el('td', {}, endpointCheckSummary(ep)),
        el('td', { class: 'target-cell', title: ep.target }, ep.target),
        el('td', { class: 'mono' }, `${ep.interval_seconds}s`),
        el('td', {}, ep.group_names.length ? ep.group_names.join(', ') : '—'),
        actionsCell(editDeleteButtons({
          onEdit: () => endpointForm.toEditMode(ep),
          confirm: {
            title: 'Delete endpoint?',
            body: `"${ep.name}" and all of its check history will be permanently deleted. This CANNOT be undone.`,
            confirmText: 'Delete endpoint'
          },
          onDelete: async () => {
            await endpointsApi.remove(ep.id);
            endpointForm.forgetIfEditing(ep.id);
            await refreshAll();
          }
        }))
      ];
    }
  });
}

// ---------- boot ----------

function renderAll() {
  renderGroupTable();
  renderEndpointTable();
  // Keep form selection valid without clobbering an in-progress edit.
  if (groupForm.editingId == null) {
    renderGroupEndpointChecks(selectedEndpointIds());
  }
}

async function refreshAll() {
  [groups, actionGroupList, endpoints] = await Promise.all([
    groupsApi.list(), actionGroups.list(), endpointsApi.list()
  ]);
  loaded = true;
  renderAll();
}

groupForm.toAddMode();
endpointForm.toAddMode();

// Fill the tables from last session's data so the page is not blank while the
// live lists are in flight; refreshAll replaces them a round trip later.
const snapshot = loadSnapshot('flatline');
if (snapshot) {
  ({ groups, actionGroupList, endpoints } = snapshot);
  renderAll();
}
saveSnapshotOnExit('flatline', () => (loaded ? { groups, actionGroupList, endpoints } : null));

void refreshAll();
