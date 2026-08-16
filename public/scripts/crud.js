/**
 * The shape every "list of things, with a form to add and edit one" page shares.
 *
 * Flatline has six of them — endpoints and Flatline groups on /flatline, action
 * targets and action groups on /actions, notification channels and wake relays
 * on /config — and each was written out in full. What differs between them is
 * genuinely small: which fields the form has, which columns the table shows, and
 * which API calls to make. Everything around that (the add/edit mode switch, the
 * stored-credential state, the delete confirmation, the empty state) is the same
 * every time, and lives here.
 *
 * dom.js stays the primitive layer — elements, dialogs, formatting. This is the
 * page-level layer built on top of it.
 */

import { el, clear, confirmDialog } from './dom.js';

// ---------- stored credentials ----------

/**
 * The "stored ✓ / clear / undo" state beside each credential input in a form.
 *
 * A saved secret is never sent back to the browser — the server returns only the
 * names of the fields it holds. So an edit form shows the field blank with a
 * note that something is stored, and leaving it blank keeps it. Clearing one is
 * an explicit act, which is what the clear/undo toggle records.
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

  /**
   * What to send for the credentials: a typed value replaces, a cleared field is
   * an explicit null, and anything left blank is omitted so the server keeps
   * what it already has. `inputs` maps each secret's field name to its input's
   * name attribute (they differ where a name has to be unique across kinds).
   */
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

/**
 * The add-versus-edit lifecycle: which id is being edited, what the heading and
 * buttons say, and what happens on submit.
 *
 * The caller owns the fields themselves — `fill` puts a row into them, `collect`
 * reads them back — because that is the part that genuinely differs. Everything
 * else is the same on all six forms.
 *
 * `siblingSection` is the other form on the same page; opening one folds the
 * other away so only one edit is in progress at a time.
 *
 * Three labels, because the wording is not uniform and shortening the heading to
 * match the button would reword six forms: `noun` names the thing in the heading
 * ("Add notification channel"), `itemLabel` is the shorter form the button uses
 * ("Add channel"), and `editLabel` prefixes the edit heading ("Edit channel:
 * NAME") — empty for the endpoint form, whose heading is just "Edit: NAME".
 */
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
          // Re-fill from the refreshed list where it is there, so the form shows
          // what the server actually stored rather than what was typed.
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
    /** Called after a delete: only drops out of edit mode if it was that row. */
    forgetIfEditing(id) { if (editingId === id) toAddMode(); }
  };
}

// ---------- tables ----------

/**
 * The Edit + Delete pair every row carries, with the delete confirmation wired
 * up. Returns the buttons so the caller can put them in whatever cell it likes,
 * alongside any per-table extras (Run, Restore, Test).
 */
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

/** The usual right-hand cell: the buttons laid out in a row. */
export function actionsCell(...buttons) {
  return el('td', {}, el('span', { style: 'display:inline-flex;gap:6px' }, ...buttons.flat()));
}

/**
 * Renders a table into `container`, or an empty-state panel when there are no
 * rows. `cells` turns one row into its `<td>`s; building them stays with the
 * caller, since that is where the six tables actually differ — some need a
 * colgroup, some a status pill of their own, some a cell that is not truncated.
 *
 * `empty` is a string, or [heading, explanation] for the two-line version.
 */
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
    el('tbody', {}, ...rows.map((row) => el('tr', {}, ...cells(row))))
  );
  container.append(table);
}
