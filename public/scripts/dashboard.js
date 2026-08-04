import {
  getDashboard, runActionGroup, pauseActionRun, resumeActionRun, cancelActionRun
} from './api.js';
import {
  el, svg, clear, showTooltip, hideTooltip, fmtTime, fmtDateTime, fmtLatency, fmtUptime,
  confirmDialog, alertDialog
} from './dom.js';
import { initHeaderAuth } from './header.js';

initHeaderAuth();

const RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '14d', hours: 336 }
];

const REFRESH_MS = 10_000;
const ACTIVE_REFRESH_MS = 3_000;

// How many rows each list shows before it starts scrolling.
const PANEL_ROWS = 3;
const EVENT_ROWS = 8;

const GROUP_BY_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'group', label: 'Flatline group' },
  { value: 'type', label: 'Check type' }
];

let rangeHours = Number(localStorage.getItem('flatline.range') ?? 24) || 24;
if (!RANGES.some((r) => r.hours === rangeHours)) rangeHours = 24;
// ?groupby=group|type makes a grouped view linkable; localStorage remembers otherwise.
const groupByParam = new URLSearchParams(location.search).get('groupby');
let groupBy = GROUP_BY_OPTIONS.some((o) => o.value === groupByParam)
  ? groupByParam
  : (localStorage.getItem('flatline.groupBy') ?? 'group');
let data = null;
let fetchedAt = 0; // local clock at fetch, for countdown drift correction

const $banners = document.getElementById('banners');
const $filters = document.getElementById('filters');
const $endpoints = document.getElementById('endpoints');
const $actionPanel = document.getElementById('action-panel');
const $events = document.getElementById('events');

async function refresh() {
  try {
    data = await getDashboard(rangeHours);
    fetchedAt = Date.now();
    render();
  } catch (err) {
    console.error('dashboard refresh failed:', err);
  }
}

function render() {
  if (!data) return;
  renderBanners();
  renderFilters();
  renderEndpoints();
  renderActionPanel();
  renderEvents();
}

// ---- per-group action banners ----

// Banners the user has cleared, by group and state. Kept in memory only: a
// dismissal hides a notice, it must never hide it for good.
const dismissedBanners = new Set();

function renderBanners() {
  clear($banners);
  const live = new Set();

  for (const g of data.groups) {
    if (!g.armed) continue;

    // A group escalating from armed to triggered is a new notice, so clearing
    // the countdown doesn't also swallow "TRIGGERED".
    const key = `${g.group_id}:${g.triggered ? 'triggered' : 'armed'}`;
    live.add(key);
    if (dismissedBanners.has(key)) continue;

    const banner = el('div', { class: `banner ${g.triggered ? 'triggered' : 'armed'}` });
    const actions = g.action_group_names.length ? g.action_group_names.join(', ') : 'no action groups assigned';

    if (g.triggered) {
      banner.append(
        el('span', { class: 'icon' }, '⛔'),
        el('span', {}, `"${g.name}" TRIGGERED — running action group(s): ${actions}.`),
        el('span', { class: 'countdown' }, g.triggered_ts ? fmtDateTime(g.triggered_ts) : '')
      );
    } else {
      const cd = el('span', { class: 'countdown' }, countdownText(g.deadline_ts));
      cd.dataset.deadline = String(g.deadline_ts ?? '');
      banner.append(
        el('span', { class: 'icon' }, '⚠️'),
        el('span', {}, `Group "${g.name}" failed (${g.down_count}/${g.endpoint_count} down) — will run: ${actions}.`),
        cd
      );
    }

    const close = el('button', { class: 'banner-x', type: 'button', title: 'Clear', 'aria-label': 'Clear' }, '×');
    close.addEventListener('click', () => {
      dismissedBanners.add(key);
      banner.remove();
    });
    banner.append(close);

    $banners.append(banner);
  }

  // Forget the dismissal once the group recovers, so a later outage says so.
  for (const key of dismissedBanners) {
    if (!live.has(key)) dismissedBanners.delete(key);
  }
}

function countdownText(deadlineTs) {
  if (!deadlineTs || !data) return '';
  const serverNowEstimate = data.now + (Date.now() - fetchedAt);
  const remaining = Math.max(0, deadlineTs - serverNowEstimate);
  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1000);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

setInterval(() => {
  for (const node of $banners.querySelectorAll('[data-deadline]')) {
    const deadline = Number(node.dataset.deadline);
    if (deadline) node.textContent = countdownText(deadline);
  }
}, 1000);

// ---- filter row ----

function renderFilters() {
  clear($filters);
  $filters.append(el('span', { class: 'label' }, 'Range'));
  for (const r of RANGES) {
    const btn = el('button', { class: `range-btn${r.hours === rangeHours ? ' active' : ''}` }, r.label);
    btn.addEventListener('click', () => {
      rangeHours = r.hours;
      localStorage.setItem('flatline.range', String(r.hours));
      void refresh();
    });
    $filters.append(btn);
  }

  $filters.append(el('span', { class: 'label', style: 'margin-left:14px' }, 'Group by'));
  const select = el('select', { class: 'groupby-select' });
  for (const opt of GROUP_BY_OPTIONS) {
    const o = el('option', { value: opt.value }, opt.label);
    if (opt.value === groupBy) o.selected = true;
    select.append(o);
  }
  select.addEventListener('change', () => {
    groupBy = select.value;
    localStorage.setItem('flatline.groupBy', groupBy);
    render();
  });
  $filters.append(select);

  const up = data.endpoints.filter(e => e.enabled && e.state === 'up').length;
  const down = data.endpoints.filter(e => e.enabled && e.state === 'down').length;
  const total = data.endpoints.filter(e => e.enabled).length;
  const text = total === 0
    ? 'No endpoints configured'
    : down > 0
      ? `${down} of ${total} endpoints DOWN`
      : `All ${total} endpoints up`;
  $filters.append(el('span', { class: 'summary' }, text));
}

// ---- endpoint cards ----

function renderEndpoints() {
  clear($endpoints);

  if (data.endpoints.length === 0) {
    $endpoints.append(el('div', { class: 'card' },
      el('div', { class: 'empty' },
        el('div', { class: 'big' }, 'No endpoints yet'),
        el('div', {}, 'Add the IPs and HTTP endpoints to watch on the '),
        el('a', { href: '/flatline' }, 'Flatline page')
      )
    ));
    return;
  }

  if (groupBy === 'none') {
    for (const ep of data.endpoints) {
      $endpoints.append(endpointCard(ep));
    }
    return;
  }

  // Bucket the cards under section headings, keeping the endpoints' order.
  // An endpoint in multiple Flatline groups appears once per group it's in.
  const sections = new Map();
  for (const ep of data.endpoints) {
    const keys = groupBy === 'group'
      ? (ep.group_names.length ? ep.group_names : ['No group'])
      : [ep.type === 'icmp' ? 'Ping (ICMP)' : 'HTTP(S)'];
    for (const key of keys) {
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key).push(ep);
    }
  }

  const collapsed = collapsedSections();
  for (const [title, eps] of sections) {
    const key = `${groupBy}:${title}`;
    const isCollapsed = collapsed.has(key);
    const down = eps.filter(e => e.enabled && e.state === 'down').length;

    const heading = el('div', { class: 'group-heading', 'aria-expanded': String(!isCollapsed) },
      el('span', { class: 'chevron' }, '▸'),
      el('span', { class: 'gh-title' }, title),
      el('span', { class: 'gh-count' }, down > 0 ? `${eps.length} endpoints · ${down} down` : `${eps.length} endpoints`)
    );

    // The cards get their own container so collapsing touches only this
    // section. Re-rendering the page here instead would empty the document for
    // an instant, and the browser would throw away the scroll position.
    const body = el('div', { class: 'group-section' });
    if (isCollapsed) body.style.display = 'none';
    else for (const ep of eps) body.append(endpointCard(ep));

    heading.addEventListener('click', () => toggleSection(key, heading, body, eps));
    $endpoints.append(heading, body);
  }
}

// Which group sections are folded away, remembered per grouping mode so
// "Flatline group" and "Check type" keep their own state.
const COLLAPSED_KEY = 'flatline.collapsedSections';

function collapsedSections() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function toggleSection(key, heading, body, eps) {
  const set = collapsedSections();
  const nowCollapsed = !set.has(key);
  if (nowCollapsed) set.add(key);
  else set.delete(key);
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));

  heading.setAttribute('aria-expanded', String(!nowCollapsed));
  body.style.display = nowCollapsed ? 'none' : '';
  // Cards are built the first time the section is actually visible — a chart
  // measured while hidden would come out the wrong width.
  if (!nowCollapsed && !body.firstChild) {
    for (const ep of eps) body.append(endpointCard(ep));
  }
}

function statusPill(ep) {
  if (!ep.enabled) {
    return el('span', { class: 'pill disabled' }, el('span', { class: 'dot' }), 'PAUSED');
  }
  const cls = ep.state === 'up' ? 'up' : ep.state === 'down' ? 'down' : 'unknown';
  const label = ep.state === 'up' ? 'UP' : ep.state === 'down' ? 'DOWN' : 'PENDING';
  return el('span', { class: `pill ${cls}` }, el('span', { class: 'dot' }), label);
}

function endpointCard(ep) {
  const card = el('div', { class: 'card endpoint-card' });

  const head = el('div', { class: 'head' },
    statusPill(ep),
    el('span', { class: 'name' }, ep.name),
    el('span', { class: 'target' }, `${ep.type === 'icmp' ? 'ping' : 'http'} · ${ep.target}`),
    ...ep.group_names.map((name) => el('span', { class: 'badge' }, `⛓ ${name}`)),
    el('span', { class: 'uptime' },
      el('div', { class: 'value' }, fmtUptime(ep.uptime_pct)),
      el('div', { class: 'label' }, `latency`)
    )
  );
  card.append(head);

  const chartWrap = el('div', { class: 'chart-wrap' });
  card.append(chartWrap);
  // Chart needs the rendered width; defer until the card is in the DOM.
  requestAnimationFrame(() => {
    const width = chartWrap.clientWidth || 600;
    if (ep.history.buckets.length === 0) {
      chartWrap.append(el('div', { class: 'beats-label' }, 'Collecting data…'));
    } else {
      chartWrap.append(latencyChart(ep, width));
    }
  });

  card.append(beatsStrip(ep));
  return card;
}

// ---- heartbeat strip (one cell per recent check) ----

function beatsStrip(ep) {
  const wrap = el('div', { class: 'beats-wrap' });
  const strip = el('div', { class: 'beats', role: 'img',
    'aria-label': `Last ${ep.recent.length} checks for ${ep.name}` });

  for (const c of ep.recent) {
    const beat = el('span', { class: `beat ${c.ok ? 'ok' : 'fail'}` });
    beat.dataset.ts = String(c.ts);
    beat.dataset.ok = String(c.ok);
    beat.dataset.lat = c.latency_ms == null ? '' : String(c.latency_ms);
    beat.dataset.err = c.error ?? '';
    strip.append(beat);
  }

  strip.addEventListener('pointermove', (e) => {
    const t = e.target;
    if (!t.dataset.ts) { hideTooltip(); return; }
    const ok = t.dataset.ok === '1';
    showTooltip(e.clientX, e.clientY, fmtDateTime(Number(t.dataset.ts)), [
      ok
        ? { value: fmtLatency(t.dataset.lat ? Number(t.dataset.lat) : null), label: 'ok', keyColor: 'var(--status-good)' }
        : { value: 'DOWN', label: t.dataset.err || undefined, keyColor: 'var(--status-critical)' }
    ]);
  });
  strip.addEventListener('pointerleave', hideTooltip);

  wrap.append(strip);
  // The range selector drives the chart only; the strip is always the last
  // N checks. Label it so that distinction is clear.
  wrap.append(el('div', { class: 'beats-caption' }, `last ${ep.recent.length} checks`));
  return wrap;
}

// ---- latency history chart ----

function niceCeil(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) {
    if (m * mag >= v) return m * mag;
  }
  return 10 * mag;
}

function latencyChart(ep, width) {
  const H = 130;
  const padL = 44, padR = 10, padT = 10, padB = 22;
  const plotW = Math.max(50, width - padL - padR);
  const plotH = H - padT - padB;

  const { bucketMs, fromTs, buckets } = ep.history;
  const rangeMs = rangeHours * 3_600_000;
  const nTotal = Math.max(1, Math.round(rangeMs / bucketMs));

  // Dense timeline: index -> bucket (or null when no checks landed there).
  const dense = new Array(nTotal).fill(null);
  for (const b of buckets) {
    if (b.bucket >= 0 && b.bucket < nTotal) dense[b.bucket] = b;
  }

  const maxLat = Math.max(1, ...buckets.map(b => b.avg_latency ?? 0));
  const yMax = niceCeil(maxLat * 1.1);

  const xAt = (i) => padL + ((i + 0.5) / nTotal) * plotW;
  const yAt = (v) => padT + plotH - (v / yMax) * plotH;

  const root = svg('svg', {
    viewBox: `0 0 ${width} ${H}`,
    width: String(width),
    height: String(H)
  });

  // gridlines + y labels (hairline, recessive)
  for (const frac of [0.5, 1]) {
    const v = yMax * frac;
    root.append(svg('line', {
      x1: String(padL), x2: String(padL + plotW),
      y1: String(yAt(v)), y2: String(yAt(v)),
      style: 'stroke:var(--gridline);stroke-width:1'
    }));
    root.append(svg('text', {
      x: String(padL - 6), y: String(yAt(v) + 3),
      'text-anchor': 'end',
      style: 'fill:var(--text-muted);font-size:10px;font-variant-numeric:tabular-nums'
    }, `${v >= 1000 ? `${v / 1000}s` : `${v}`}`));
  }
  // baseline
  root.append(svg('line', {
    x1: String(padL), x2: String(padL + plotW),
    y1: String(yAt(0)), y2: String(yAt(0)),
    style: 'stroke:var(--baseline);stroke-width:1'
  }));
  root.append(svg('text', {
    x: String(padL - 6), y: String(yAt(0) + 3), 'text-anchor': 'end',
    style: 'fill:var(--text-muted);font-size:10px'
  }, '0'));

  // x-axis time labels
  const tickCount = width > 500 ? 4 : 2;
  for (let t = 0; t <= tickCount; t++) {
    const i = Math.round((t / tickCount) * (nTotal - 1));
    const anchor = t === 0 ? 'start' : t === tickCount ? 'end' : 'middle';
    root.append(svg('text', {
      x: String(xAt(i)), y: String(H - 6), 'text-anchor': anchor,
      style: 'fill:var(--text-muted);font-size:10px'
    }, fmtTime(fromTs + i * bucketMs, rangeHours)));
  }

  // outage bands: full-down buckets get a stronger wash than partial failures
  for (let i = 0; i < nTotal; i++) {
    const b = dense[i];
    if (!b || b.ok_count >= b.total) continue;
    const fullDown = b.ok_count === 0;
    root.append(svg('rect', {
      x: String(padL + (i / nTotal) * plotW),
      y: String(padT),
      width: String(plotW / nTotal),
      height: String(plotH),
      style: `fill:var(--status-critical);opacity:${fullDown ? 0.20 : 0.08}`
    }));
  }

  // latency line + area wash, split into segments across gaps
  let segment = [];
  const segments = [];
  for (let i = 0; i < nTotal; i++) {
    const b = dense[i];
    if (b && b.avg_latency != null) {
      segment.push([xAt(i), yAt(Math.min(b.avg_latency, yMax))]);
    } else if (segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
  }
  if (segment.length > 0) segments.push(segment);

  for (const seg of segments) {
    const first = seg[0];
    const last = seg[seg.length - 1];
    const lineD = seg.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    root.append(svg('path', {
      d: `${lineD}L${last[0].toFixed(1)},${yAt(0)}L${first[0].toFixed(1)},${yAt(0)}Z`,
      style: 'fill:var(--series-1);opacity:0.1'
    }));
    if (seg.length === 1) {
      root.append(svg('circle', {
        cx: String(first[0]), cy: String(first[1]), r: '2.5',
        style: 'fill:var(--series-1)'
      }));
    } else {
      root.append(svg('path', {
        d: lineD,
        style: 'fill:none;stroke:var(--series-1);stroke-width:2;stroke-linecap:round;stroke-linejoin:round'
      }));
    }
  }

  // crosshair + hover layer
  const crosshair = svg('line', {
    y1: String(padT), y2: String(padT + plotH),
    style: 'stroke:var(--baseline);stroke-width:1;display:none'
  });
  root.append(crosshair);

  const overlay = svg('rect', {
    x: String(padL), y: String(padT),
    width: String(plotW), height: String(plotH),
    style: 'fill:transparent;cursor:crosshair'
  });
  root.append(overlay);

  overlay.addEventListener('pointermove', (e) => {
    const rect = root.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let i = Math.floor(((px - padL) / plotW) * nTotal);
    i = Math.max(0, Math.min(nTotal - 1, i));

    // snap to the nearest bucket that has data
    let found = -1;
    for (let d = 0; d < nTotal; d++) {
      if (i - d >= 0 && dense[i - d]) { found = i - d; break; }
      if (i + d < nTotal && dense[i + d]) { found = i + d; break; }
    }
    if (found < 0) { crosshair.style.display = 'none'; hideTooltip(); return; }

    const b = dense[found];
    const cx = xAt(found);
    crosshair.setAttribute('x1', String(cx));
    crosshair.setAttribute('x2', String(cx));
    crosshair.style.display = '';

    const rows = [];
    if (b.avg_latency != null) {
      rows.push({ value: fmtLatency(b.avg_latency), label: 'avg latency', keyColor: 'var(--series-1)' });
    }
    rows.push(b.ok_count === b.total
      ? { value: `${b.ok_count}/${b.total}`, label: 'checks up', keyColor: 'var(--status-good)' }
      : { value: `${b.total - b.ok_count}/${b.total}`, label: 'checks failed', keyColor: 'var(--status-critical)' });
    showTooltip(e.clientX, e.clientY, fmtTime(fromTs + found * bucketMs, rangeHours), rows);
  });
  overlay.addEventListener('pointerleave', () => {
    crosshair.style.display = 'none';
    hideTooltip();
  });

  return root;
}

// ---- action groups + running actions (split row) ----

const RUN_STATUS = {
  running:     { cls: 'down',     label: 'RUNNING' },
  paused:      { cls: 'unknown',  label: 'PAUSED' },
  completed:   { cls: 'up',       label: 'COMPLETED' },
  failed:      { cls: 'down',     label: 'FAILED' },
  cancelled:   { cls: 'disabled', label: 'CANCELLED' },
  interrupted: { cls: 'disabled', label: 'INTERRUPTED' }
};

const STEP_STATE_MARK = { running: '⋯', ok: '✓', failed: '✕', skipped: '⊘' };

const PANEL_KEY = 'flatline.actionPanelCollapsed';

function renderActionPanel() {
  // Refreshes rebuild these lists from scratch; without this a poll would yank
  // a scrolled list back to the top under the user.
  const scrolled = new Map([...$actionPanel.querySelectorAll('.row-list')]
    .map((l) => [l.dataset.list, l.scrollTop]));

  clear($actionPanel);
  const collapsed = localStorage.getItem(PANEL_KEY) === '1';
  $actionPanel.append(
    panelCard('Action groups', collapsed, actionGroupNodes),
    panelCard('Action runs', collapsed, runListNodes)
  );

  for (const list of $actionPanel.querySelectorAll('.row-list')) {
    capList(list, PANEL_ROWS);
    list.scrollTop = scrolled.get(list.dataset.list) ?? 0;
  }
}

/**
 * Show at most `max` rows and scroll the rest. The cap is measured off the rows
 * themselves rather than set in CSS, since row heights vary — a run mid-stage
 * carries step chips and buttons that a finished one doesn't.
 *
 * Call this with `list` already in the document, and synchronously: shortening
 * the page a frame later is what makes the browser clamp the scroll position.
 */
function capList(list, max) {
  const rows = list.children;
  if (rows.length <= max) return;
  const top = list.getBoundingClientRect().top;
  list.style.maxHeight = `${rows[max].getBoundingClientRect().top - top}px`;
  list.classList.add('scroll-list');
}

/** The two halves fold as one — collapsing a single side would leave the row
 *  lopsided, so either header toggles both. */
function panelCard(title, collapsed, buildBody) {
  const header = el('div', { class: 'card-header', 'aria-expanded': String(!collapsed) },
    el('h2', {}, title),
    el('span', { class: 'chevron' }, '▸'));
  header.addEventListener('click', () => {
    localStorage.setItem(PANEL_KEY, collapsed ? '0' : '1');
    renderActionPanel(); // this row only — a full render would reset the scroll position
  });

  const card = el('div', { class: 'card' }, header);
  if (!collapsed) card.append(el('div', { class: 'card-body' }, ...buildBody()));
  return card;
}

function actionGroupNodes() {
  if (data.action_groups.length === 0) {
    return [el('div', { class: 'empty' },
      el('div', {}, 'No action groups yet — build one on the '),
      el('a', { href: '/actions' }, 'Actions page'))];
  }

  const list = el('div', { class: 'row-list', 'data-list': 'groups' });
  for (const g of data.action_groups) {
    const running = data.action_runs.some(
      (r) => r.action_group_id === g.id && (r.status === 'running' || r.status === 'paused'));

    const runBtn = el('button', { class: 'btn danger-soft small' }, 'Run now');
    runBtn.disabled = running || g.target_total === 0;
    if (running) runBtn.title = 'This action group is already running';
    else if (g.target_total === 0) runBtn.title = 'This action group has no targets yet';
    runBtn.addEventListener('click', () => void startRun(g, runBtn));

    // Targets are counted once even when a group reuses one across stages.
    const counts = [`${g.target_up}/${g.target_total} targets up`];
    if (g.target_down > 0) counts.push(`${g.target_down} down`);
    if (g.target_disabled > 0) counts.push(`${g.target_disabled} disabled`);

    list.append(el('div', { class: 'ag-row' },
      el('div', { class: 'ag-head' },
        el('span', { class: `pill ${g.enabled ? 'up' : 'disabled'}` },
          el('span', { class: 'dot' }), g.enabled ? 'ENABLED' : 'DISABLED'),
        el('span', { class: 'ag-name' }, g.name),
        runBtn),
      el('div', { class: 'ag-meta' },
        el('span', {}, `${g.stage_count} stage${g.stage_count === 1 ? '' : 's'}`),
        el('span', {}, counts.join(' · ')),
        g.last_run
          ? el('span', {}, `last run ${fmtDateTime(g.last_run.started_at)} (${g.last_run.status})`)
          : el('span', {}, 'never run')),
      g.flatline_group_names.length
        ? el('div', { class: 'ag-meta' },
            ...g.flatline_group_names.map((n) => el('span', { class: 'ag-badge' }, `⛓ ${n}`)))
        : el('div', { class: 'ag-meta' }, el('span', {}, 'not assigned to a Flatline group'))
    ));
  }
  return [list];
}

async function startRun(group, btn) {
  const ok = await confirmDialog({
    title: 'Run this action group now?',
    body: [
      `This runs all ${group.stage_count} stage(s) of "${group.name}" immediately, against every target in them.`,
      'These are the real shutdown/drain actions — they CANNOT be undone from here!'
    ],
    confirmText: 'Run now',
    danger: true
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await runActionGroup(group.id);
  } catch (err) {
    await alertDialog({ title: 'Could not start the run', body: err.message });
  }
  await refresh();
}

function runListNodes() {
  const live = data.action_runs.filter((r) => r.status === 'running' || r.status === 'paused');
  // Nothing executing: fall back to the recent history so the panel still says
  // something useful about what these action groups last did.
  const shown = live.length ? live : data.action_runs.slice(0, 5);

  if (shown.length === 0) {
    return [el('div', { class: 'empty' },
      el('div', {}, 'Nothing has run yet. Runs appear here when a Flatline group triggers, or when you start one.'))];
  }

  // The caption sits outside the list so it stays put while the runs scroll.
  const nodes = live.length === 0
    ? [el('div', { class: 'run-caption' }, 'Nothing running right now — most recent runs:')]
    : [];
  nodes.push(el('div', { class: 'row-list', 'data-list': 'runs' }, ...shown.map(runRow)));
  return nodes;
}

function runRow(run) {
  const status = RUN_STATUS[run.status] ?? { cls: 'unknown', label: run.status.toUpperCase() };
  const live = run.status === 'running' || run.status === 'paused';

  const row = el('div', { class: 'run-row' });
  row.append(el('div', { class: 'run-head' },
    el('span', { class: `pill ${status.cls}` }, el('span', { class: 'dot' }), status.label),
    el('span', { class: 'run-name' }, run.action_group_name),
    el('span', { class: 'run-stage' },
      run.stage_count ? `stage ${Math.min(run.stage_index + 1, run.stage_count)} of ${run.stage_count}` : 'no stages')
  ));

  const timing = live
    ? `started ${fmtDateTime(run.started_at)}${run.estimated_end_ts
        ? ` · done by ${fmtDateTime(run.estimated_end_ts)} at the latest` : ''}`
    : `${fmtDateTime(run.started_at)} → ${run.ended_at ? fmtDateTime(run.ended_at) : '—'}`;
  row.append(el('div', { class: 'run-meta' },
    el('span', {}, timing),
    el('span', {}, run.trigger === 'manual' ? 'started manually' : `triggered by "${run.trigger_detail}"`)
  ));

  // The steps of a stage run at once, so this is the whole stage's progress,
  // not a single "current" step.
  if (run.steps.length) {
    row.append(el('div', { class: 'run-steps' }, ...run.steps.map((s) =>
      el('span', { class: `run-step ${s.state}` }, `${STEP_STATE_MARK[s.state] ?? ''} ${s.name}`))));
  }
  if (run.message) row.append(el('div', { class: 'run-message' }, run.message));

  if (live) row.append(runControls(run));
  return row;
}

function runControls(run) {
  const wrap = el('div', { class: 'run-btns' });

  const paused = run.status === 'paused';
  const pauseBtn = el('button', { class: 'btn ghost small' }, paused ? 'Resume' : 'Pause');
  pauseBtn.disabled = !run.controllable || run.cancel_requested;
  pauseBtn.addEventListener('click', () => void control(paused ? resumeActionRun : pauseActionRun, run, pauseBtn));

  const cancelBtn = el('button', { class: 'btn danger-ghost small' }, 'Cancel');
  cancelBtn.disabled = !run.controllable || run.cancel_requested;
  cancelBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await confirmDialog({
        title: 'Cancel this run?',
        body: [
          `"${run.action_group_name}" will stop before its next stage. Stages already run are NOT undone.`,
          'The targets in the stage running right now finish first — a command already sent to a machine cannot be recalled.'
        ],
        confirmText: 'Cancel run',
        danger: true
      });
      if (ok) await control(cancelActionRun, run, cancelBtn);
    })();
  });

  wrap.append(pauseBtn, cancelBtn);
  if (!run.controllable) {
    wrap.append(el('span', { class: 'run-note' }, 'this run is no longer controllable'));
  } else if (run.cancel_requested) {
    wrap.append(el('span', { class: 'run-note' }, 'cancelling after the current stage…'));
  } else if (run.pause_requested && run.status === 'running') {
    wrap.append(el('span', { class: 'run-note' }, 'pausing after the current stage…'));
  }
  return wrap;
}

async function control(fn, run, btn) {
  btn.disabled = true;
  try {
    await fn(run.id);
  } catch (err) {
    await alertDialog({ title: 'Could not change the run', body: err.message });
  }
  await refresh();
}

// ---- events ----

const EVENTS_KEY = 'flatline.eventsCollapsed';

function renderEvents() {
  const collapsed = localStorage.getItem(EVENTS_KEY) === '1';
  const scrolled = $events.querySelector('.row-list')?.scrollTop ?? 0;
  clear($events);

  const header = el('div', { class: 'card-header', 'aria-expanded': String(!collapsed) },
    el('h2', {}, 'Recent events'),
    el('span', { class: 'chevron' }, '▸'));
  header.addEventListener('click', () => {
    localStorage.setItem(EVENTS_KEY, collapsed ? '0' : '1');
    renderEvents(); // this card only — a full render would reset the scroll position
  });
  $events.append(header);
  if (collapsed) return;

  if (data.events.length === 0) {
    $events.append(el('div', { class: 'card-body' },
      el('div', { class: 'empty' }, 'No events yet — state changes and action activity will appear here.')));
    return;
  }

  const list = el('div', { class: 'row-list' });
  for (const ev of data.events) {
    let what = '';
    let cls = '';
    if (ev.kind === 'state') {
      what = ev.to_state === 'up' ? '▲ UP' : '▼ DOWN';
      cls = ev.to_state === 'up' ? 'to-up' : 'to-down';
    } else if (ev.kind === 'shutdown_armed') {
      what = '⚠ countdown armed'; cls = 'to-down';
    } else if (ev.kind === 'shutdown_disarmed') {
      what = '✓ countdown disarmed'; cls = 'to-up';
    } else if (ev.kind === 'shutdown_triggered') {
      what = '⛔ ACTIONS TRIGGERED'; cls = 'to-down';
    } else if (ev.kind === 'action_run_started') {
      what = '▶ run started'; cls = 'to-down';
    } else if (ev.kind === 'action_run_completed') {
      what = '■ run completed'; cls = 'to-up';
    } else if (ev.kind === 'action_run_failed') {
      what = '■ run failed'; cls = 'to-down';
    } else if (ev.kind === 'action_step_ok') {
      what = '✓ step ok'; cls = 'to-up';
    } else if (ev.kind === 'action_step_failed') {
      what = '✕ step failed'; cls = 'to-down';
    } else if (ev.kind === 'action_step_skipped') {
      what = '⊘ step skipped';
    } else {
      what = ev.kind;
    }

    list.append(el('div', { class: 'event-row' },
      el('span', { class: 'time' }, fmtDateTime(ev.ts)),
      el('span', { class: `what ${cls}` }, what),
      ev.endpoint_name ? el('span', {}, ev.endpoint_name) : null,
      ev.message ? el('span', { class: 'msg' }, ev.message) : null
    ));
  }

  $events.append(el('div', { class: 'card-body' }, list));
  capList(list, EVENT_ROWS);
  list.scrollTop = scrolled;
}

// ---- boot ----

let resizeTimer;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(render, 150);
});

// A run's stages turn over in seconds, so poll faster while one is live.
function scheduleRefresh() {
  const live = data?.action_runs.some((r) => r.status === 'running' || r.status === 'paused');
  setTimeout(() => void refresh().finally(scheduleRefresh), live ? ACTIVE_REFRESH_MS : REFRESH_MS);
}
void refresh().finally(scheduleRefresh);
