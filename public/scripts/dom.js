/** Element builder — children are appended as nodes or text (textContent-safe). */
export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class')
            node.className = v;
        else
            node.setAttribute(k, v);
    }
    for (const child of children) {
        if (child == null)
            continue;
        node.append(child);
    }
    return node;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs))
        node.setAttribute(k, v);
    for (const child of children) {
        if (child == null)
            continue;
        node.append(child);
    }
    return node;
}
export function clear(node) {
    while (node.firstChild)
        node.removeChild(node.firstChild);
}
/**
 * Shows the descendants of `root` whose `data-<attr>` names `value` and hides
 * the rest — the one move every "which fields does this choice need?" toggle on
 * the forms makes (target kind, SSH auth method, ntfy scheme, wake mode, …).
 *
 * The attribute may list several values separated by spaces
 * (`data-http="bearer basic"`), for a field that more than one choice needs; a
 * single value is just the one-element case, so both read the same here.
 */
export function toggleByData(root, attr, value) {
    // data-ssh-auth -> dataset.sshAuth
    const key = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    for (const node of root.querySelectorAll(`[data-${attr}]`)) {
        node.style.display = node.dataset[key].split(' ').includes(value) ? '' : 'none';
    }
}
/** Plain enabled/disabled label for things with no live health/state to show
 *  (Flatline groups, action groups) — just the on/off switch, no dot. */
export function enabledPill(enabled) {
    return el('span', { class: `pill ${enabled ? 'up' : 'disabled'}` }, enabled ? 'ENABLED' : 'DISABLED');
}

/** Wires up a click-to-toggle card section (header + body), collapsed by
 *  default, remembered per-browser across refreshes via localStorage.
 *  Returns { expand(), collapse() } so callers can force the state (clicking
 *  Edit on a table row reveals that form, and folds the page's other form away
 *  so only one edit form is open at a time). */
export function initCollapsible(key, headerEl, bodyEl) {
    const storageKey = `flatline:collapsed:${key}`;
    let collapsed = localStorage.getItem(storageKey) !== '0';

    function apply() {
        bodyEl.style.display = collapsed ? 'none' : '';
        headerEl.setAttribute('aria-expanded', String(!collapsed));
    }
    function setCollapsed(next) {
        collapsed = next;
        localStorage.setItem(storageKey, collapsed ? '1' : '0');
        apply();
    }
    // A "?" beside the title is not part of the fold control. initHelp is
    // delegated from the document, so its stopPropagation lands too late to
    // keep the click from reaching this listener first — it is skipped here.
    headerEl.addEventListener('click', (e) => {
        if (e.target.closest('.help'))
            return;
        setCollapsed(!collapsed);
    });
    apply();

    return { expand: () => setCollapsed(false), collapse: () => setCollapsed(true) };
}
/**
 * Click-to-open help popovers. A field carries a "?" button beside its label and
 * the prose that used to sit under it as a sibling `.help-pop`:
 *
 *   <span class="help">
 *     <button type="button" class="help-btn" aria-expanded="false">?</button>
 *     <span class="help-pop" role="tooltip" hidden>…</span>
 *   </span>
 *
 * Hovering the "?" opens it and leaving closes it again; clicking pins it open
 * so the prose can be read (and copied) without keeping the pointer still, and
 * so keyboard and touch reach it too. One is open at a time; Escape or a click
 * anywhere else closes it. Delegated from the document so markup rendered later
 * needs no re-initialising, and so every page gets the same behaviour from one
 * call.
 */
export function initHelp() {
    let open = null;
    function close() {
        if (!open)
            return;
        open.pop.hidden = true;
        open.pop.classList.remove('flip');
        open.btn.setAttribute('aria-expanded', 'false');
        open = null;
    }
    function show(btn, pinned) {
        const pop = btn.parentElement?.querySelector('.help-pop');
        if (!pop)
            return;
        close();
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        open = { btn, pop, pinned };
        // Opened flush against the right edge of the viewport it would be
        // cut off, so it hangs from the other corner instead.
        if (pop.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
            pop.classList.add('flip');
        }
    }
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.help-btn');
        if (btn) {
            // These buttons sit inside a <label>, where a click would otherwise
            // focus the field, so the event stops here.
            e.preventDefault();
            e.stopPropagation();
            if (open?.btn === btn && open.pinned)
                close();
            else
                show(btn, true);
            return;
        }
        if (open && !e.target.closest('.help-pop'))
            close();
    });
    document.addEventListener('mouseover', (e) => {
        const btn = e.target.closest('.help-btn');
        if (btn && open?.btn !== btn)
            show(btn, false);
    });
    document.addEventListener('mouseout', (e) => {
        if (!open || open.pinned)
            return;
        // The popover is a child of the same .help wrapper as its button, so
        // moving between the two never leaves it — only leaving the pair does.
        const wrap = open.btn.parentElement;
        if (wrap.contains(e.target) && !wrap.contains(e.relatedTarget))
            close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape')
            close();
    });
}
/**
 * Wires a tab bar to its panels: each [role="tab"] button carries data-tab, and
 * the panel it reveals carries a matching data-panel. The choice is remembered
 * per-browser; a URL hash beats that on load, so another page can deep-link to
 * one tab (e.g. /config#relays).
 *
 * Panels are hidden, never detached — every element inside stays in the DOM, so
 * the getElementById lookups the page does at load keep working whichever tab
 * happens to be showing.
 */
export function initTabs(key, tablistEl) {
    const storageKey = `flatline:tab:${key}`;
    const tabs = [...tablistEl.querySelectorAll('[role="tab"]')];
    const panels = [...document.querySelectorAll('[data-panel]')];
    let active = tabs[0]?.dataset.tab;

    function show(name, focus = false) {
        // theme-init.js stamps the stored tab on <html> so the right panel is
        // the one that paints, since this module is deferred and arrives too
        // late to prevent the wrong one showing first. From here `hidden` below
        // decides, and leaving the stamp on would have CSS force that panel open
        // whichever tab is picked.
        document.documentElement.removeAttribute(`data-tab-${key}`);
        active = tabs.some((t) => t.dataset.tab === name) ? name : tabs[0]?.dataset.tab;
        for (const tab of tabs) {
            const on = tab.dataset.tab === active;
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-selected', String(on));
            // Only the selected tab is in the tab order; arrows move between them.
            tab.tabIndex = on ? 0 : -1;
            if (on && focus) tab.focus();
        }
        for (const panel of panels) panel.hidden = panel.dataset.panel !== active;
        localStorage.setItem(storageKey, active);
    }

    tablistEl.addEventListener('click', (e) => {
        const tab = e.target.closest('[role="tab"]');
        if (tab) show(tab.dataset.tab);
    });
    tablistEl.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const i = tabs.findIndex((t) => t.dataset.tab === active);
        show(tabs[(i + step + tabs.length) % tabs.length].dataset.tab, true);
    });

    show(location.hash.slice(1) || localStorage.getItem(storageKey));
    return { show };
}

// ---- shared tooltip (values lead, labels follow; textContent only) ----
let tooltipEl = null;
function tooltip() {
    if (!tooltipEl) {
        tooltipEl = el('div', { class: 'viz-tooltip' });
        document.body.append(tooltipEl);
    }
    return tooltipEl;
}
export function showTooltip(clientX, clientY, time, rows) {
    const tt = tooltip();
    clear(tt);
    tt.append(el('div', { class: 'tt-time' }, time));
    for (const row of rows) {
        const key = row.keyColor
            ? el('span', { class: 'tt-key', style: `background:${row.keyColor}` })
            : null;
        tt.append(el('div', { class: 'tt-row' }, key, el('span', { class: 'tt-value' }, row.value), row.label ? el('span', { class: 'tt-label' }, row.label) : null));
    }
    tt.style.display = 'block';
    const pad = 12;
    const rect = tt.getBoundingClientRect();
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + rect.width > window.innerWidth - 8)
        x = clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8)
        y = clientY - rect.height - pad;
    tt.style.left = `${x}px`;
    tt.style.top = `${y}px`;
}
export function hideTooltip() {
    if (tooltipEl)
        tooltipEl.style.display = 'none';
}
// ---- styled dialogs (replace native confirm()/alert()) ----
/** Shared dialog. `body` is a string or array of paragraphs. Resolves true when
 *  confirmed, false when cancelled/dismissed. With no cancelText it's an alert
 *  (single button, resolves true). Enter confirms, Escape/backdrop cancels. */
export function showDialog({ title = '', body = [], confirmText = 'OK', cancelText = null, danger = false } = {}) {
    const lines = (Array.isArray(body) ? body : [body]).filter(Boolean);
    return new Promise((resolve) => {
        let done = false;
        const overlay = el('div', { class: 'modal-overlay' });
        const confirmBtn = el('button', { type: 'button', class: `btn${danger ? ' danger-ghost' : ''}` }, confirmText);
        const cancelBtn = cancelText != null
            ? el('button', { type: 'button', class: 'btn ghost' }, cancelText)
            : null;

        overlay.append(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, title ? el('h2', { class: 'modal-title' }, title) : null, ...lines.map((t) => el('p', { class: 'modal-body' }, t)), el('div', { class: 'modal-actions' }, cancelBtn, confirmBtn)));

        function close(result) {
            if (done)
                return;
            done = true;
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(result);
        }
        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                close(false);
            }
            else if (e.key === 'Enter') {
                e.preventDefault();
                close(true);
            }
        }
        confirmBtn.addEventListener('click', () => close(true));
        if (cancelBtn)
            cancelBtn.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
        document.addEventListener('keydown', onKey);

        document.body.append(overlay);
        confirmBtn.focus();
    });
}
/** window.confirm() replacement: OK/Cancel, styled to match the app. */
export function confirmDialog(opts) {
    return showDialog({ confirmText: 'Confirm', cancelText: 'Cancel', ...opts });
}
/** window.alert() replacement: a single dismiss button. */
export function alertDialog(opts) {
    return showDialog({ confirmText: 'OK', ...opts });
}
/** Shows "Unsaved changes" in noteEl whenever the form gets user input, and
 *  clears an optional "Saved ✓" note at the same time. Programmatic changes
 *  (form.reset(), setting .value) fire no input event, so loading/filling a
 *  form stays clean. Call markClean() after save/reset/fill. */
export function initDirtyNote(form, noteEl, savedEl = null) {
    const markDirty = () => {
        noteEl.textContent = 'Unsaved changes';
        if (savedEl)
            savedEl.textContent = '';
    };
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
    return { markDirty, markClean: () => { noteEl.textContent = ''; } };
}
/**
 * Wire a "load from file" button + hidden file input so picking a file reads its
 * text into target.value. The file is never uploaded or written anywhere — only
 * its contents are pulled into the field, then saved by the normal form submit.
 */
export function wireFileUpload(btn, fileInput, target, onLoad) {
    btn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file)
            return;
        const reader = new FileReader();
        reader.onload = () => {
            target.value = reader.result;
            fileInput.value = ''; // reset so re-picking the same file fires change again
            if (onLoad)
                onLoad();
        };
        reader.readAsText(file);
    });
}
// ---- formatting helpers ----
// Fixed mm/dd/yy + 24-hour clock, independent of browser locale, so every
// timestamp in the app reads the same way (no AM/PM).
function pad2(n) {
    return String(n).padStart(2, '0');
}
function fmtDate(d) {
    return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${pad2(d.getFullYear() % 100)}`;
}
function fmtClock(d, withSeconds) {
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return withSeconds ? `${hm}:${pad2(d.getSeconds())}` : hm;
}
export function fmtTime(ts, rangeHours) {
    const d = new Date(ts);
    const hm = fmtClock(d, false);
    if (rangeHours <= 24)
        return hm;
    return `${fmtDate(d)} ${hm}`;
}
export function fmtDateTime(ts) {
    const d = new Date(ts);
    return `${fmtDate(d)} ${fmtClock(d, true)}`;
}
export function fmtLatency(ms) {
    if (ms == null)
        return '—';
    if (ms < 1)
        return '<1 ms';
    if (ms < 100)
        return `${Math.round(ms * 10) / 10} ms`;
    return `${Math.round(ms)} ms`;
}
export function fmtUptime(pct) {
    if (pct == null)
        return '—';
    if (pct === 100)
        return '100%';
    return `${pct.toFixed(pct >= 99 ? 2 : 1)}%`;
}
