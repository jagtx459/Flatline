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
/** Plain enabled/disabled label for things with no live health/state to show
 *  (Flatline groups, action groups) — just the on/off switch, no dot. */
export function enabledPill(enabled) {
    return el('span', { class: `pill ${enabled ? 'up' : 'disabled'}` }, enabled ? 'ENABLED' : 'DISABLED');
}

/** Wires up a click-to-toggle card section (header + body), collapsed by
 *  default, remembered per-browser across refreshes via localStorage.
 *  Returns { expand() } so callers can force it open (e.g. clicking Edit
 *  on a table row should reveal the form even if the section is collapsed). */
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
    headerEl.addEventListener('click', () => setCollapsed(!collapsed));
    apply();

    return { expand: () => setCollapsed(false) };
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
