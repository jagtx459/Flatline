/**
 * dom.js stays the primitive layer — elements, dialogs, formatting. This is the
 * page-level layer built on top of it.
 */

import { el, clear, confirmDialog } from './dom.js';

// ---------- stored credentials ----------

/**
 * The "stored ✓ / clear / undo" state beside each credential input in a form.
 *
 * A saved secret is never sent back to the browser — the server returns only the
 * names of the fields it holds. 
 *
 * `sectionAttr` scopes a credential to the kind it belongs to: a label inside a
 * `[data-<sectionAttr>]` block only counts when that block is the chosen kind.
 * With `unsectionedIsGlobal`, a label outside every such block counts for every
 * kind — the Actions page needs it, because one Restore panel serves all four
 * target kinds and its credentials sit outside the per-kind sections.
 */
export function initSecretFields(form, { sectionAttr, unsectionedIsGlobal = false, onDirty }) {
  let cleared = new Set();

  /** Repaints every credential's state for `kind`; also drops any pending clears. */
  function render(kind, storedFields) {
    cleared = new Set();
    for (const label of form.querySelectorAll('label.secret')) {
      const state = label.querySelector('.secret-state');
      clear(state);

      const name = label.dataset.secret;
      const section = label.closest(`[data-${sectionAttr}]`);
      const inScope = section
        ? section.dataset[sectionAttr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] === kind
        : unsectionedIsGlobal;
      if (!storedFields.includes(name) || !inScope) continue;

      const hint = el('span', {}, '· stored ✓ (leave blank to keep) ');
      const btn = el('button', { type: 'button', class: 'link-btn' }, 'clear');
      btn.addEventListener('click', () => {
        if (cleared.has(name)) {
          cleared.delete(name);
          btn.textContent = 'clear';
          hint.textContent = '· stored ✓ (leave blank to keep) ';
        } else {
          cleared.add(name);
          btn.textContent = 'undo';
          hint.textContent = '· will be removed on save ';
        }
        onDirty();
      });
      state.append(hint, btn);
    }
  }

  function collect(inputs) {
    const secrets = {};
    for (const [name, inputName] of Object.entries(inputs)) {
      const value = form.elements.namedItem(inputName).value;
      if (cleared.has(name)) secrets[name] = null;
      else if (value) secrets[name] = value;
    }
    return secrets;
  }

  return { render, collect };
}

// ---------- the add/edit form ----------
export function initEntityForm({
  form, els, section, dirty, noun, itemLabel = noun, editLabel = itemLabel,
  api, collect, fill, reset, refresh, siblingSection, findSaved
}) {
  let editingId = null;

  function toAddMode() {
    editingId = null;
    form.reset();
    els.title.textContent = `Add ${noun}`;
    els.submit.textContent = `Add ${itemLabel}`;
    els.cancel.style.display = 'none';
    if (els.reset) els.reset.style.display = '';
    els.error.textContent = '';
    if (els.saveNote) els.saveNote.textContent = '';
    if (els.testResult) els.testResult.textContent = '';
    dirty.markClean();
    reset?.();
  }

  function toEditMode(row) {
    toAddMode();
    editingId = row.id;
    fill(row);
    els.title.textContent = editLabel ? `Edit ${editLabel}: ${row.name}` : `Edit: ${row.name}`;
    els.submit.textContent = 'Save changes';
    els.cancel.style.display = '';
    if (els.reset) els.reset.style.display = 'none';
    dirty.markClean();
    section?.expand();
    siblingSection?.().collapse(); // one edit form open at a time
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  els.cancel.addEventListener('click', (e) => {
    e.preventDefault();
    toAddMode();
  });
  els.reset?.addEventListener('click', () => toAddMode());

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const wasEditing = editingId != null;
      try {
        const input = collect();
        const saved = wasEditing ? await api.update(editingId, input) : await api.create(input);
        els.error.textContent = '';
        await refresh(saved);
        if (wasEditing) {
          toEditMode(findSaved?.(saved.id) ?? saved);
          if (els.saveNote) els.saveNote.textContent = 'Saved ✓';
        } else {
          toAddMode();
        }
      } catch (err) {
        els.error.textContent = err.message;
      }
    })();
  });

  return {
    get editingId() { return editingId; },
    toAddMode,
    toEditMode,
    forgetIfEditing(id) { if (editingId === id) toAddMode(); }
  };
}

// ---------- tables ----------
export function editDeleteButtons({ onEdit, confirm, onDelete }) {
  const edit = el('button', { class: 'btn ghost small' }, 'Edit');
  edit.addEventListener('click', onEdit);

  const del = el('button', { class: 'btn danger-ghost small' }, 'Delete');
  del.addEventListener('click', () => {
    void (async () => {
      if (!await confirmDialog({ danger: true, ...confirm })) return;
      await onDelete();
    })();
  });

  return [edit, del];
}

export function actionsCell(...buttons) {
  return el('td', {}, el('span', { class: 'row-btns' }, ...buttons.flat()));
}

export function renderTable(container, { headers, rows, cells, empty, colWidths, className = 'endpoints' }) {
  clear(container);

  if (rows.length === 0) {
    const lines = Array.isArray(empty) ? empty : [empty];
    container.append(el('div', { class: 'empty' },
      lines.length > 1 ? el('div', { class: 'big' }, lines[0]) : lines[0],
      ...lines.slice(1).map((line) => el('div', {}, line))));
    return;
  }

  const table = el('table', { class: className });
  if (colWidths) {
    table.append(el('colgroup', {}, ...colWidths.map((w) => el('col', { style: `width:${w}` }))));
  }
  table.append(
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map((row) => {
      const tds = cells(row);
      tds.forEach((td, i) => { if (headers[i]) td.dataset.label = headers[i]; });
      return el('tr', {}, ...tds);
    }))
  );
  container.append(table);
}
