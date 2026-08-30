import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, importFresh, click, flush } from './helpers/jsdom-env.js';

/**
 * public/scripts/crud.js — the machinery every "list of things, with a form to
 * add and edit one" page shares. Six pages route through it (endpoints and
 * Flatline groups, action targets and action groups, notification channels and
 * relays), so a mistake here is six bugs.
 *
 * These run against a jsdom document; see tests/helpers/jsdom-env.js for what
 * that can and cannot cover.
 */

const CRUD = new URL('../public/scripts/crud.js', import.meta.url).href;

let env;
let crud;

beforeEach(async () => {
  env = setupDom();
  crud = await importFresh(CRUD);
});
afterEach(() => env.cleanup());

/** The buttons inside the dialog confirmDialog() puts on the page. */
function dialogButtons() {
  const actions = env.document.querySelector('.modal-overlay .modal-actions');
  if (!actions) return null;
  const buttons = [...actions.querySelectorAll('button')];
  // showDialog appends cancel then confirm; an alert has confirm only.
  return buttons.length > 1
    ? { cancel: buttons[0], confirm: buttons[1] }
    : { cancel: null, confirm: buttons[0] };
}

// ---------- renderTable ----------

describe('renderTable', () => {
  const opts = {
    headers: ['Name', 'Kind', ''],
    cells: (r) => [
      env.document.createElement('td'),
      env.document.createElement('td'),
      env.document.createElement('td')
    ]
  };

  test('builds a header row and one body row per item', () => {
    const host = env.document.createElement('div');
    crud.renderTable(host, {
      headers: ['Name', 'Kind'],
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      cells: (r) => [
        Object.assign(env.document.createElement('td'), { textContent: `row-${r.id}` }),
        env.document.createElement('td')
      ],
      empty: 'nothing'
    });

    assert.equal(host.querySelectorAll('thead th').length, 2);
    assert.deepEqual(
      [...host.querySelectorAll('thead th')].map((th) => th.textContent),
      ['Name', 'Kind']
    );
    assert.equal(host.querySelectorAll('tbody tr').length, 3);
    assert.equal(host.querySelector('tbody tr td').textContent, 'row-1');
  });

  test('replaces whatever was there before, rather than appending', () => {
    const host = env.document.createElement('div');
    const render = (n) => crud.renderTable(host, {
      headers: ['Name'],
      rows: Array.from({ length: n }, (_, i) => ({ id: i })),
      cells: () => [env.document.createElement('td')],
      empty: 'nothing'
    });

    render(3);
    render(1);
    assert.equal(host.querySelectorAll('table').length, 1, 'one table, not two');
    assert.equal(host.querySelectorAll('tbody tr').length, 1);
  });

  test('a one-line empty state is plain text, with no table', () => {
    const host = env.document.createElement('div');
    crud.renderTable(host, { ...opts, rows: [], empty: 'No relays yet.' });

    assert.equal(host.querySelector('table'), null);
    const empty = host.querySelector('.empty');
    assert.equal(empty.textContent, 'No relays yet.');
    assert.equal(empty.querySelector('.big'), null, 'no heading for the one-line form');
  });

  test('a two-line empty state gets a heading and an explanation', () => {
    const host = env.document.createElement('div');
    crud.renderTable(host, { ...opts, rows: [], empty: ['No relays yet', 'Add one only if…'] });

    const empty = host.querySelector('.empty');
    assert.equal(empty.querySelector('.big').textContent, 'No relays yet');
    assert.match(empty.textContent, /Add one only if…/);
  });

  test('colWidths become a colgroup, and the class is configurable', () => {
    const host = env.document.createElement('div');
    crud.renderTable(host, {
      ...opts,
      rows: [{ id: 1 }],
      colWidths: ['10%', '20%', '70%'],
      className: 'endpoints target-table'
    });

    const cols = host.querySelectorAll('colgroup col');
    assert.equal(cols.length, 3);
    assert.equal(cols[1].getAttribute('style'), 'width:20%');
    assert.equal(host.querySelector('table').className, 'endpoints target-table');
  });

  test('defaults to the endpoints class when none is given', () => {
    const host = env.document.createElement('div');
    crud.renderTable(host, { ...opts, rows: [{ id: 1 }] });
    assert.equal(host.querySelector('table').className, 'endpoints');
    assert.equal(host.querySelector('colgroup'), null);
  });

  // On a phone the stylesheet hides the header row and prints each cell's
  // data-label beside it instead, so a row reads as a stacked card. Without
  // these attributes that layout is a column of unlabelled values.
  test('every cell carries its column heading as data-label', () => {
    const host = env.document.createElement('div');
    crud.renderTable(host, { ...opts, rows: [{ id: 1 }, { id: 2 }] });

    for (const row of host.querySelectorAll('tbody tr')) {
      const tds = row.querySelectorAll('td');
      assert.equal(tds[0].dataset.label, 'Name');
      assert.equal(tds[1].dataset.label, 'Kind');
      // The last column heads the buttons and is deliberately blank; the
      // stylesheet keys the full-width, ruled-off cell on having no label.
      assert.equal(tds[2].dataset.label, undefined);
    }
  });
});

// ---------- editDeleteButtons ----------

describe('editDeleteButtons', () => {
  const confirmText = { title: 'Delete?', body: 'Gone forever.', confirmText: 'Delete' };

  test('Edit fires immediately, with no confirmation', () => {
    let edited = 0;
    const [edit] = crud.editDeleteButtons({
      onEdit: () => { edited += 1; },
      confirm: confirmText,
      onDelete: async () => {}
    });

    click(edit);
    assert.equal(edited, 1);
    assert.equal(dialogButtons(), null, 'Edit must not open a dialog');
  });

  test('Delete asks first, and does nothing when cancelled', async () => {
    let deleted = 0;
    const [, del] = crud.editDeleteButtons({
      onEdit: () => {},
      confirm: confirmText,
      onDelete: async () => { deleted += 1; }
    });
    env.document.body.append(del);

    click(del);
    await flush();

    const buttons = dialogButtons();
    assert.ok(buttons, 'a confirmation dialog opened');
    assert.match(env.document.querySelector('.modal').textContent, /Gone forever\./);

    click(buttons.cancel);
    await flush();
    assert.equal(deleted, 0, 'cancelling must not delete');
  });

  test('Delete runs onDelete once confirmed', async () => {
    let deleted = 0;
    const [, del] = crud.editDeleteButtons({
      onEdit: () => {},
      confirm: confirmText,
      onDelete: async () => { deleted += 1; }
    });
    env.document.body.append(del);

    click(del);
    await flush();
    click(dialogButtons().confirm);
    await flush();

    assert.equal(deleted, 1);
    assert.equal(env.document.querySelector('.modal-overlay'), null, 'dialog closed again');
  });

  test('the delete button is styled as the destructive one', () => {
    const [edit, del] = crud.editDeleteButtons({ onEdit: () => {}, confirm: confirmText, onDelete: async () => {} });
    assert.equal(edit.textContent, 'Edit');
    assert.equal(del.textContent, 'Delete');
    assert.match(del.className, /danger-ghost/);
  });
});

test('actionsCell flattens the button groups it is handed', () => {
  const one = env.document.createElement('button');
  const pair = [env.document.createElement('button'), env.document.createElement('button')];

  const cell = crud.actionsCell(one, pair);
  assert.equal(cell.tagName, 'TD');
  assert.equal(cell.querySelectorAll('button').length, 3);
});

// ---------- initSecretFields ----------

describe('initSecretFields', () => {
  /** Two kind-sections, each with one credential, plus one outside any section
   *  — the shape the Actions page has, where the Restore panel is shared. */
  const FORM = `
    <form id="f">
      <div class="kind-section" data-kind="ssh">
        <label class="secret" data-secret="password">
          <input name="ssh_password" type="password">
          <span class="secret-state"></span>
        </label>
      </div>
      <div class="kind-section" data-kind="k8s">
        <label class="secret" data-secret="token">
          <input name="k8s_token" type="password">
          <span class="secret-state"></span>
        </label>
      </div>
      <label class="secret" data-secret="restore_password">
        <input name="restore_password" type="password">
        <span class="secret-state"></span>
      </label>
    </form>`;

  function build({ unsectionedIsGlobal = false } = {}) {
    env.document.body.innerHTML = FORM;
    const form = env.document.getElementById('f');
    let dirty = 0;
    const secrets = crud.initSecretFields(form, {
      sectionAttr: 'kind',
      unsectionedIsGlobal,
      onDirty: () => { dirty += 1; }
    });
    return { form, secrets, dirtyCount: () => dirty };
  }

  const stateOf = (name) =>
    env.document.querySelector(`label[data-secret="${name}"] .secret-state`);

  test('marks stored credentials only inside the chosen kind', () => {
    const { secrets } = build();
    secrets.render('ssh', ['password', 'token']);

    assert.match(stateOf('password').textContent, /stored ✓/, 'ssh password is in scope');
    assert.equal(stateOf('token').textContent, '', 'the k8s token belongs to another kind');
  });

  test('a field with no stored value shows nothing, whatever the kind', () => {
    const { secrets } = build();
    secrets.render('ssh', []);
    assert.equal(stateOf('password').textContent, '');
  });

  test('unsectionedIsGlobal decides whether a shared credential is in scope', () => {
    const scoped = build({ unsectionedIsGlobal: false });
    scoped.secrets.render('ssh', ['restore_password']);
    assert.equal(stateOf('restore_password').textContent, '',
      'off: a label outside every section belongs to no kind');

    const shared = build({ unsectionedIsGlobal: true });
    shared.secrets.render('ssh', ['restore_password']);
    assert.match(stateOf('restore_password').textContent, /stored ✓/,
      'on: it belongs to every kind — one Restore panel serves all four');
  });

  test('clear then undo returns to the stored state, marking the form dirty each way', () => {
    const { secrets, dirtyCount } = build();
    secrets.render('ssh', ['password']);
    const button = stateOf('password').querySelector('button');

    assert.equal(button.textContent, 'clear');

    click(button);
    assert.equal(button.textContent, 'undo');
    assert.match(stateOf('password').textContent, /will be removed on save/);
    assert.equal(dirtyCount(), 1);

    click(button);
    assert.equal(button.textContent, 'clear');
    assert.match(stateOf('password').textContent, /stored ✓/);
    assert.equal(dirtyCount(), 2);
  });

  test('collect: typed replaces, blank is omitted, cleared is an explicit null', () => {
    const { form, secrets } = build();
    secrets.render('ssh', ['password']);
    const inputs = { password: 'ssh_password', token: 'k8s_token' };

    // blank everywhere -> send nothing, so the server keeps what it holds
    assert.deepEqual(secrets.collect(inputs), {});

    form.elements.namedItem('ssh_password').value = 'hunter2';
    assert.deepEqual(secrets.collect(inputs), { password: 'hunter2' });

    // cleared wins over whatever is typed: null means "remove it"
    click(stateOf('password').querySelector('button'));
    assert.deepEqual(secrets.collect(inputs), { password: null });
  });

  test('re-rendering drops any pending clear', () => {
    const { secrets } = build();
    secrets.render('ssh', ['password']);
    click(stateOf('password').querySelector('button'));
    assert.deepEqual(secrets.collect({ password: 'ssh_password' }), { password: null });

    secrets.render('ssh', ['password']); // e.g. switching to another row
    assert.deepEqual(secrets.collect({ password: 'ssh_password' }), {},
      'the previous row\'s pending clear must not carry over');
  });
});

// ---------- initEntityForm ----------

describe('initEntityForm', () => {
  const MARKUP = `
    <form id="f">
      <input name="name">
      <input name="enabled" type="checkbox">
    </form>
    <h2 id="title"></h2>
    <button id="submit"></button>
    <button id="cancel"></button>
    <button id="reset"></button>
    <span id="error"></span>
    <span id="save-note"></span>`;

  function build(over = {}) {
    env.document.body.innerHTML = MARKUP;
    const document = env.document;
    const form = document.getElementById('f');
    const calls = { created: [], updated: [], refreshed: 0, collapsed: 0 };

    const api = {
      create: async (input) => { calls.created.push(input); return { id: 7, name: input.name }; },
      update: async (id, input) => { calls.updated.push([id, input]); return { id, name: input.name }; }
    };

    const entity = crud.initEntityForm({
      form,
      els: {
        title: document.getElementById('title'),
        submit: document.getElementById('submit'),
        cancel: document.getElementById('cancel'),
        reset: document.getElementById('reset'),
        error: document.getElementById('error'),
        saveNote: document.getElementById('save-note')
      },
      dirty: { markClean() {}, markDirty() {} },
      noun: 'notification channel',
      itemLabel: 'channel',
      api,
      collect: () => ({ name: form.elements.namedItem('name').value }),
      fill: (row) => { form.elements.namedItem('name').value = row.name; },
      refresh: async () => { calls.refreshed += 1; },
      siblingSection: () => ({ collapse: () => { calls.collapsed += 1; } }),
      ...over
    });

    return { entity, form, calls, document };
  }

  const submit = (form) =>
    form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));

  test('add mode names the thing in the heading and the item on the button', () => {
    const { entity, document } = build();
    entity.toAddMode();

    assert.equal(document.getElementById('title').textContent, 'Add notification channel');
    assert.equal(document.getElementById('submit').textContent, 'Add channel');
    assert.equal(document.getElementById('cancel').style.display, 'none');
    assert.equal(document.getElementById('reset').style.display, '');
    assert.equal(entity.editingId, null);
  });

  test('edit mode swaps the labels and reveals Cancel', () => {
    const { entity, document, form } = build();
    entity.toEditMode({ id: 3, name: 'pager' });

    assert.equal(document.getElementById('title').textContent, 'Edit channel: pager');
    assert.equal(document.getElementById('submit').textContent, 'Save changes');
    assert.equal(document.getElementById('cancel').style.display, '');
    assert.equal(document.getElementById('reset').style.display, 'none');
    assert.equal(entity.editingId, 3);
    assert.equal(form.elements.namedItem('name').value, 'pager', 'fill() ran');
  });

  test('an empty editLabel gives the bare "Edit: NAME" heading', () => {
    const { entity, document } = build({ noun: 'Flatline endpoint', itemLabel: 'endpoint', editLabel: '' });
    entity.toEditMode({ id: 1, name: 'router' });

    assert.equal(document.getElementById('title').textContent, 'Edit: router');
    assert.equal(document.getElementById('submit').textContent, 'Save changes');
  });

  test('itemLabel falls back to noun when it is not given', () => {
    const { entity, document } = build({ noun: 'relay', itemLabel: undefined });
    entity.toAddMode();
    assert.equal(document.getElementById('submit').textContent, 'Add relay');
  });

  test('opening an edit folds the page\'s other form away', () => {
    const { entity, calls } = build();
    entity.toEditMode({ id: 3, name: 'pager' });
    assert.equal(calls.collapsed, 1);
  });

  test('submitting in add mode creates, then returns to add mode', async () => {
    const { entity, form, calls, document } = build();
    entity.toAddMode();
    form.elements.namedItem('name').value = 'new-thing';

    submit(form);
    await flush(5);

    assert.deepEqual(calls.created, [{ name: 'new-thing' }]);
    assert.equal(calls.updated.length, 0);
    assert.equal(calls.refreshed, 1);
    assert.equal(entity.editingId, null, 'back to add mode');
    assert.equal(document.getElementById('title').textContent, 'Add notification channel');
  });

  test('submitting in edit mode updates that id and stays on the row', async () => {
    const { entity, form, calls, document } = build({
      findSaved: (id) => ({ id, name: 'from-server' })
    });
    entity.toEditMode({ id: 3, name: 'pager' });
    form.elements.namedItem('name').value = 'renamed';

    submit(form);
    await flush(5);

    assert.equal(calls.created.length, 0);
    assert.deepEqual(calls.updated, [[3, { name: 'renamed' }]]);
    assert.equal(entity.editingId, 3, 'still editing the same row');
    assert.equal(document.getElementById('save-note').textContent, 'Saved ✓');
    assert.equal(form.elements.namedItem('name').value, 'from-server',
      're-filled from the refreshed list, not from what was typed');
  });

  test('a failed save shows the reason and keeps you in edit mode', async () => {
    const { entity, form, document } = build({
      api: {
        create: async () => { throw new Error('that name is already in use'); },
        update: async () => { throw new Error('that name is already in use'); }
      }
    });
    entity.toEditMode({ id: 3, name: 'pager' });

    submit(form);
    await flush(5);

    assert.equal(document.getElementById('error').textContent, 'that name is already in use');
    assert.equal(entity.editingId, 3, 'the edit is not thrown away');
  });

  test('Cancel abandons the edit', () => {
    const { entity, document } = build();
    entity.toEditMode({ id: 3, name: 'pager' });
    click(document.getElementById('cancel'));

    assert.equal(entity.editingId, null);
    assert.equal(document.getElementById('title').textContent, 'Add notification channel');
  });

  test('forgetIfEditing only drops out for the row that was deleted', () => {
    const { entity } = build();
    entity.toEditMode({ id: 3, name: 'pager' });

    entity.forgetIfEditing(99);
    assert.equal(entity.editingId, 3, 'another row being deleted changes nothing');

    entity.forgetIfEditing(3);
    assert.equal(entity.editingId, null, 'the row being edited was deleted');
  });

  test('switching straight from one row to another leaves no trace of the first', () => {
    const { entity, form, document } = build();
    entity.toEditMode({ id: 3, name: 'pager' });
    document.getElementById('error').textContent = 'stale error';
    entity.toEditMode({ id: 4, name: 'siren' });

    assert.equal(entity.editingId, 4);
    assert.equal(form.elements.namedItem('name').value, 'siren');
    assert.equal(document.getElementById('error').textContent, '', 'the old error was cleared');
  });
});
