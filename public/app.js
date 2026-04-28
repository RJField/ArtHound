const state = {
  assets:       [],
  selected:     null,
  schedule:     null,
  writing:      false,
  scheduleView: 'table',
};

const $ = id => document.getElementById(id);

const $search       = $('search-input');
const $assetList    = $('asset-list');
const $emptyState   = $('empty-state');
const $assetPanel   = $('asset-panel');
const $panelHeader  = $('panel-header');
const $metaGrid     = $('meta-grid');
const $previewBtn   = $('preview-btn');
const $schedSection = $('schedule-section');
const $tbody        = $('schedule-tbody');
const $taskCount    = $('task-count');
const $generateBtn  = $('generate-btn');
const $statusMsg    = $('status-msg');
const $toast        = $('toast');
const $nameBtn      = $('name-btn');
const $nameOutput   = $('name-output');
const $nameText     = $('name-text');
const $nameCopy     = $('name-copy');

// -- Navigation --

function navigate(view) {
  document.querySelectorAll('.view').forEach(v => { v.style.display = 'none'; });
  const el = document.getElementById(`view-${view}`);
  el.style.display = (view === 'home' || view === 'estimates' || view === 'workflows' || view === 'reviews' || view === 'todos') ? 'flex' : 'block';
  if (view === 'assets') { if (!state.assets.length) loadAssets(); }
  if (view === 'reviews') loadReviews();
}

document.getElementById('nav-assets').addEventListener('click', () => navigate('assets'));
document.getElementById('nav-estimates').addEventListener('click', () => navigate('estimates'));
document.getElementById('nav-workflows').addEventListener('click', () => navigate('workflows'));
document.getElementById('nav-reviews').addEventListener('click', () => navigate('reviews'));
document.getElementById('nav-todos').addEventListener('click', () => navigate('todos'));
fetch('/api/config')
  .then(r => r.json())
  .then(({ airtableUrl }) => {
    const btn = document.getElementById('nav-airtable');
    if (airtableUrl) {
      btn.addEventListener('click', () => window.open(airtableUrl, '_blank', 'noopener'));
    } else {
      btn.disabled = true;
      btn.title = 'AIRTABLE_BASE_ID not configured';
    }
  });
document.getElementById('home-btn').addEventListener('click', () => navigate('home'));
document.getElementById('estimates-home-btn').addEventListener('click', () => navigate('home'));
document.getElementById('workflows-home-btn').addEventListener('click', () => navigate('home'));
document.getElementById('reviews-home-btn').addEventListener('click', () => navigate('home'));
document.getElementById('todos-home-btn').addEventListener('click', () => navigate('home'));

// -- Utilities --

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function showToast(msg, type = 'info') {
  $toast.textContent = msg;
  $toast.className = `toast toast-${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 4000);
}

// -- Asset list --

async function loadAssets(query = '') {
  $assetList.innerHTML = '<div class="list-state">Loading…</div>';
  try {
    const url = query ? `/api/assets?search=${encodeURIComponent(query)}` : '/api/assets';
    state.assets = await apiFetch(url);
    renderAssetList();
  } catch (err) {
    $assetList.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderAssetList() {
  if (!state.assets.length) {
    $assetList.innerHTML = '<div class="list-state">No assets found</div>';
    return;
  }
  $assetList.innerHTML = state.assets.map(a => `
    <div class="asset-item${state.selected?.id === a.id ? ' active' : ''}" data-id="${esc(a.id)}">
      <div class="asset-item-name">${esc(a.name)}</div>
      <div class="asset-item-meta">
        <span class="tag">${esc(a.itemType || '—')}</span>
        ${a.priority != null ? `<span class="prio prio-${a.priority}">P${a.priority}</span>` : ''}
        <span class="muted">${esc(a.product || '—')}</span>
      </div>
    </div>
  `).join('');

  $assetList.querySelectorAll('.asset-item').forEach(el => {
    el.addEventListener('click', () => selectAsset(el.dataset.id));
  });
}

// -- Asset selection --

function selectAsset(id) {
  const asset = state.assets.find(a => a.id === id);
  if (!asset) return;

  state.selected = asset;
  state.schedule = null;
  renderAssetList();

  $emptyState.style.display  = 'none';
  $assetPanel.style.display  = 'block';
  $schedSection.style.display = 'none';

  $panelHeader.innerHTML = `
    <h1 class="asset-title">${esc(asset.name)}</h1>
    <span class="asset-type-badge">${esc(asset.itemType || 'Unknown')}</span>
  `;

  const projectDate = asset.projectDate;
  $metaGrid.innerHTML = `
    <div class="meta-item">
      <div class="meta-label">Product</div>
      <div class="meta-value">${esc(asset.product || '—')}</div>
    </div>
    <div class="meta-item">
      <div class="meta-label">Team</div>
      <div class="meta-value">${esc(asset.team || '—')}</div>
    </div>
    <div class="meta-item">
      <div class="meta-label">Priority</div>
      <div class="meta-value">
        ${asset.priority != null ? `<span class="prio prio-${asset.priority}">P${asset.priority}</span>` : '—'}
      </div>
    </div>
    <div class="meta-item">
      <div class="meta-label">Project Date</div>
      <div class="meta-value">${fmtDate(projectDate)}</div>
    </div>
  `;

  $previewBtn.disabled    = false;
  $previewBtn.textContent = 'Preview Schedule';
  $statusMsg.innerHTML    = '';
  $nameOutput.style.display = 'none';
}

// -- Preview --

$previewBtn.addEventListener('click', async () => {
  if (!state.selected) return;
  $previewBtn.disabled    = true;
  $previewBtn.textContent = 'Generating…';
  $schedSection.style.display = 'none';

  try {
    state.schedule = await apiFetch('/api/schedule/preview', {
      method: 'POST',
      body: JSON.stringify({ assetId: state.selected.id }),
    });
    renderSchedule();
  } catch (err) {
    showToast(err.message, 'error');
    $previewBtn.disabled    = false;
    $previewBtn.textContent = 'Preview Schedule';
  }
});

// -- Generate name --

$nameBtn.addEventListener('click', async () => {
  if (!state.selected) return;
  const a = state.selected;
  const parts = [a.devName, a.itemType, a.product, a.assetNumber].filter(p => p != null && p !== '');
  const name = parts.join(' - ');
  $nameText.textContent = name;
  $nameOutput.style.display = '';
  $nameBtn.disabled = true;
  try {
    await apiFetch(`/api/assets/${a.id}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    state.selected.name = name;
    $panelHeader.innerHTML = `
      <h1 class="asset-title">${esc(name)}</h1>
      <span class="asset-type-badge">${esc(a.itemType || 'Unknown')}</span>
    `;
    await loadAssets($search.value);
    showToast('Name written to Airtable', 'info');
  } catch (err) {
    showToast(`Failed to write name: ${err.message}`, 'error');
  } finally {
    $nameBtn.disabled = false;
  }
});

$nameCopy.addEventListener('click', () => {
  const text = $nameText.textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => showToast('Name copied to clipboard', 'info'));
});

// -- View toggle --

document.getElementById('view-toggle').addEventListener('click', e => {
  const btn = e.target.closest('.view-btn');
  if (!btn) return;
  state.scheduleView = btn.dataset.view;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.getElementById('table-view').style.display    = state.scheduleView === 'table'    ? '' : 'none';
  document.getElementById('timeline-view').style.display = state.scheduleView === 'timeline' ? '' : 'none';
});

function renderSchedule() {
  if (!state.schedule) return;

  const tasks = [...state.schedule.tasks].sort((a, b) =>
    a.startDate.localeCompare(b.startDate)
  );

  const col = state.schedule.asset?.estimateCol;
  $taskCount.textContent = `${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;

  if (tasks.length === 0) {
    $tbody.innerHTML = `
      <tr><td colspan="5" class="schedule-empty-hint">
        No tasks with estimates found.
        ${col ? `Looking for column <code>${esc(col)}</code> in Task Templates — create it via the ⚙ wizard or add it directly in Airtable and fill in day values.` : ''}
      </td></tr>
    `;
    $generateBtn.disabled = true;
  } else {
    $tbody.innerHTML = tasks.map(t => `
      <tr>
        <td>${esc(t.taskName)}</td>
        <td>${esc(t.craft)}</td>
        <td class="col-num">${t.estimate}</td>
        <td class="col-date">${fmtDate(t.startDate)}</td>
        <td class="col-date">${fmtDate(t.endDate)}</td>
      </tr>
    `).join('');
    $generateBtn.disabled    = false;
    $generateBtn.textContent = 'Write to Airtable';
    renderTimeline(tasks);
  }

  // Respect current view toggle state
  document.getElementById('table-view').style.display    = state.scheduleView === 'table'    ? '' : 'none';
  document.getElementById('timeline-view').style.display = state.scheduleView === 'timeline' ? '' : 'none';

  $schedSection.style.display = 'block';
  $previewBtn.disabled        = false;
  $previewBtn.textContent     = 'Refresh Schedule';
  $statusMsg.innerHTML        = '';
}

// -- Timeline --

const TL_PALETTE = ['#7c6af4','#34d399','#60a5fa','#fbbf24','#f97316','#e879f9','#94a3b8','#f87171'];

function renderTimeline(tasks) {
  const $tl = document.getElementById('timeline-view');

  const parsed = tasks.map(t => ({
    ...t,
    s: new Date(t.startDate),
    e: new Date(t.endDate),
  }));

  const minMs  = Math.min(...parsed.map(t => +t.s));
  const maxMs  = Math.max(...parsed.map(t => +t.e));
  const spanMs = maxMs - minMs || 1;

  function leftPct(ms)     { return ((ms - minMs) / spanMs * 100).toFixed(3); }
  function widthPct(s, e)  { return (Math.max(+e - +s, spanMs * 0.008) / spanMs * 100).toFixed(3); }

  // Assign a stable color per craft name
  const craftColor = {};
  let ci = 0;
  parsed.forEach(t => { if (t.craft && !craftColor[t.craft]) craftColor[t.craft] = TL_PALETTE[ci++ % TL_PALETTE.length]; });

  // Month markers: first of each month spanning the range
  const markers = [];
  const cur = new Date(new Date(minMs).getFullYear(), new Date(minMs).getMonth(), 1);
  while (+cur <= maxMs) {
    markers.push({ ms: +cur, label: cur.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) });
    cur.setMonth(cur.getMonth() + 1);
  }

  $tl.innerHTML = `
    <div class="tl-chart">
      <div class="tl-labels">
        <div class="tl-label-hdr"></div>
        ${parsed.map(t => `<div class="tl-label" title="${esc(t.taskName)}">${esc(t.taskName)}</div>`).join('')}
      </div>
      <div class="tl-canvas">
        <div class="tl-month-row">
          ${markers.map(m => `
            <span class="tl-month-marker" style="left:${Math.max(0, leftPct(m.ms))}%">${esc(m.label)}</span>
          `).join('')}
        </div>
        ${markers.map(m => +m.ms >= minMs
          ? `<span class="tl-vline" style="left:${leftPct(m.ms)}%"></span>`
          : '').join('')}
        <div class="tl-rows">
          ${parsed.map(t => {
            const color = craftColor[t.craft] || TL_PALETTE[0];
            return `
              <div class="tl-row">
                <div class="tl-bar" style="left:${leftPct(t.s)}%;width:${widthPct(t.s, t.e)}%;background:${color}"
                     title="${esc(t.taskName)} · ${t.estimate}d · ${t.startDate} → ${t.endDate}">
                  <span class="tl-bar-label">${esc(t.craft)}</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

// -- Write to Airtable --

$generateBtn.addEventListener('click', async () => {
  if (!state.selected || state.writing) return;
  state.writing = true;
  $generateBtn.disabled    = true;
  $generateBtn.textContent = 'Writing…';
  $statusMsg.innerHTML     = '';

  try {
    const result = await apiFetch('/api/schedule/generate', {
      method: 'POST',
      body: JSON.stringify({ assetId: state.selected.id }),
    });
    $statusMsg.innerHTML     = `<span class="status-ok">✓ ${result.created} tasks written to Airtable</span>`;
    $generateBtn.textContent = 'Write Again';
    showToast(`${result.created} tasks created`, 'success');
  } catch (err) {
    $statusMsg.innerHTML     = `<span class="status-err">✗ ${esc(err.message)}</span>`;
    $generateBtn.textContent = 'Write to Airtable';
    showToast(err.message, 'error');
  } finally {
    state.writing         = false;
    $generateBtn.disabled = false;
  }
});

// -- Setup wizard --

const $setupOverlay = $('setup-overlay');
const $setupBtn     = $('est-setup-btn');
const $setupClose   = $('setup-close');
const $setupBody    = $('setup-body');
const $wizardSteps  = $('wizard-steps');
const $wizardFooter = $('wizard-footer');

const WIZARD_STEP_LABELS = ['Variables', 'Values', 'Matrix', 'Create'];

const wizard = {
  step:     1,
  fields:   [],          // [{id, name, type}] — eligible fields
  selected: new Set(),   // selected field names
  values:   {},          // fieldName → [{id, name}]
  combos:   [],          // [{label, values: {field: {id, name}}}]
  excluded: new Set(),   // indices of combos to skip
  filters:  {},          // fieldName → Set<value name> (included values)
  groupBy:  '',          // field name to group rows by, or ''
  result:   null,
};

$setupBtn.addEventListener('click', openSetup);
$setupClose.addEventListener('click', () => $setupOverlay.classList.remove('open'));
$setupOverlay.addEventListener('click', e => { if (e.target === $setupOverlay) $setupOverlay.classList.remove('open'); });

async function openSetup() {
  wizard.step     = 1;
  wizard.selected = new Set();
  wizard.values   = {};
  wizard.combos   = [];
  wizard.excluded = new Set();
  wizard.filters  = {};
  wizard.groupBy  = '';
  wizard.result   = null;
  $setupOverlay.classList.add('open');
  await renderWizardStep();
}

function renderWizardNav() {
  $wizardSteps.innerHTML = WIZARD_STEP_LABELS.map((label, i) => {
    const n = i + 1;
    const cls = n < wizard.step ? 'done' : n === wizard.step ? 'active' : '';
    return `<div class="wstep ${cls}"><span class="wstep-num">${n < wizard.step ? '✓' : n}</span>${label}</div>`;
  }).join('<div class="wstep-connector"></div>');
}

async function renderWizardStep() {
  renderWizardNav();
  $setupBody.innerHTML = '<div class="list-state">Loading…</div>';
  $wizardFooter.innerHTML = '';

  if (wizard.step === 1) await renderStep1();
  else if (wizard.step === 2) await renderStep2();
  else if (wizard.step === 3) renderStep3();
  else if (wizard.step === 4) await renderStep4();
}

// Step 1 — pick variable fields
async function renderStep1() {
  try {
    if (!wizard.fields.length) {
      const data = await apiFetch('/api/setup/fields');
      wizard.fields = data.fields;
    }

    $setupBody.innerHTML = `
      <div class="wizard-section-title">Select the fields that drive your estimation variables</div>
      <div class="wizard-section-sub">These are the fields whose combinations determine which estimate to use (e.g. Item Type, Team, Priority).</div>
      <div class="wizard-field-list" id="wfield-list">
        ${wizard.fields.map(f => `
          <label class="wizard-field-row">
            <input type="checkbox" value="${esc(f.name)}" ${wizard.selected.has(f.name) ? 'checked' : ''}>
            <span class="wf-name">${esc(f.name)}</span>
            <span class="ftype ftype-${esc(f.type === 'multipleRecordLinks' ? 'link' : f.type === 'singleSelect' || f.type === 'multipleSelects' ? 'select' : 'number')}">${esc(f.type)}</span>
          </label>
        `).join('')}
      </div>
    `;

    document.querySelectorAll('#wfield-list input').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) wizard.selected.add(cb.value);
        else wizard.selected.delete(cb.value);
      });
    });
  } catch (err) {
    $setupBody.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }

  $wizardFooter.innerHTML = `
    <div></div>
    <button class="btn btn-primary" id="w-next">Next →</button>
  `;
  $('w-next').addEventListener('click', async () => {
    if (!wizard.selected.size) return showToast('Select at least one variable field', 'error');
    wizard.step = 2;
    await renderWizardStep();
  });
}

// Step 2 — review discovered values per field
async function renderStep2() {
  const fields = [...wizard.selected];

  try {
    // Fetch values for any fields not yet loaded
    for (const field of fields) {
      if (!wizard.values[field]) {
        const data = await apiFetch(`/api/setup/field-values?field=${encodeURIComponent(field)}`);
        wizard.values[field] = data.values;
      }
    }

    $setupBody.innerHTML = fields.map(field => {
      const vals = wizard.values[field] || [];
      return `
        <div class="wizard-value-group">
          <div class="wizard-value-heading">${esc(field)} <span class="badge">${vals.length} values</span></div>
          <div class="wizard-value-chips">
            ${vals.map(v => `<span class="value-chip">${esc(v.name)}</span>`).join('')}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    $setupBody.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }

  $wizardFooter.innerHTML = `
    <button class="btn btn-ghost" id="w-back">← Back</button>
    <button class="btn btn-primary" id="w-next">Next →</button>
  `;
  $('w-back').addEventListener('click', async () => { wizard.step = 1; await renderWizardStep(); });
  $('w-next').addEventListener('click', async () => {
    buildCombinations();
    wizard.step = 3;
    await renderWizardStep();
  });
}

function buildCombinations() {
  const fields = [...wizard.selected];
  const valueSets = fields.map(f => wizard.values[f] || []);
  let combos = [{}];
  fields.forEach((field, i) => {
    combos = combos.flatMap(partial =>
      valueSets[i].map(v => ({ ...partial, [field]: v }))
    );
  });
  wizard.combos = combos.map(values => ({
    label: fields.map(f => values[f]?.name ?? '?').join(' | '),
    values,
  }));
}

// Step 3 — preview the matrix with filtering, grouping, and per-row selection
function renderStep3() {
  const fields = [...wizard.selected];
  const total  = wizard.combos.length;

  // Initialize per-field filters: all values included by default
  fields.forEach(f => {
    if (!wizard.filters[f]) {
      wizard.filters[f] = new Set((wizard.values[f] || []).map(v => v.name));
    }
  });

  // ---- Pure helpers ----

  function getVisibleIndices() {
    return wizard.combos.reduce((acc, c, i) => {
      if (fields.every(f => {
        const v  = c.values[f]?.name ?? '';
        const fs = wizard.filters[f];
        return !fs || fs.has(v);
      })) acc.push(i);
      return acc;
    }, []);
  }

  function selectedCount() { return total - wizard.excluded.size; }

  // ---- DOM helpers (run after initial render) ----

  function updateSubtitle() {
    const el = document.getElementById('matrix-sub-text');
    if (el) el.innerHTML = `${selectedCount()} of ${total} combination${total !== 1 ? 's' : ''} selected — will be added as columns to <strong>Task Templates</strong>.`;
  }

  function updateAllCb() {
    const allCb = document.getElementById('matrix-all');
    if (!allCb) return;
    const vis  = getVisibleIndices();
    if (!vis.length) { allCb.checked = false; allCb.indeterminate = false; return; }
    const excl = vis.filter(i => wizard.excluded.has(i)).length;
    allCb.checked       = excl === 0;
    allCb.indeterminate = excl > 0 && excl < vis.length;
  }

  function buildTbody() {
    const vis = getVisibleIndices();
    if (!vis.length) {
      return `<tr><td colspan="${fields.length + 1}" style="text-align:center;padding:20px;color:var(--text-muted)">No combinations match the current filters</td></tr>`;
    }

    function dataRow(i) {
      const c    = wizard.combos[i];
      const excl = wizard.excluded.has(i);
      return `<tr class="${excl ? 'row-excluded' : ''}">
        <td class="col-check"><input type="checkbox" data-idx="${i}" ${!excl ? 'checked' : ''}></td>
        ${fields.map(f => `<td>${esc(c.values[f]?.name ?? '—')}</td>`).join('')}
      </tr>`;
    }

    if (!wizard.groupBy) return vis.map(dataRow).join('');

    // Build groups ordered by first occurrence
    const groupMap = new Map();
    vis.forEach(i => {
      const key = wizard.combos[i].values[wizard.groupBy]?.name ?? '—';
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(i);
    });

    let html = '';
    for (const [gkey, indices] of groupMap) {
      const allExcl  = indices.every(i => wizard.excluded.has(i));
      const noneExcl = indices.every(i => !wizard.excluded.has(i));
      html += `<tr class="matrix-group-header">
        <td class="col-check"><input type="checkbox" class="group-cb" data-gkey="${esc(gkey)}"
          ${noneExcl ? 'checked' : ''} ${(!noneExcl && !allExcl) ? 'data-partial="1"' : ''}></td>
        <td colspan="${fields.length}"><strong>${esc(wizard.groupBy)}: ${esc(gkey)}</strong>
          <span class="badge" style="margin-left:8px">${indices.length}</span></td>
      </tr>`;
      html += indices.map(dataRow).join('');
    }
    return html;
  }

  function refreshTbody() {
    const tbody = document.getElementById('matrix-tbody');
    if (!tbody) return;
    tbody.innerHTML = buildTbody();
    tbody.querySelectorAll('.group-cb[data-partial="1"]').forEach(cb => { cb.indeterminate = true; });
    updateAllCb();
    updateSubtitle();
  }

  // ---- Initial HTML ----

  $setupBody.innerHTML = `
    <div class="matrix-toolbar">
      <div class="matrix-row-1">
        <div class="mf-groupby-wrap">
          <span class="mf-label">Group by</span>
          <select id="matrix-groupby">
            <option value="">— none —</option>
            ${fields.map(f => `<option value="${esc(f)}" ${wizard.groupBy === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
          </select>
        </div>
        <div class="matrix-btns">
          <button class="btn btn-ghost btn-sm" id="m-sel-vis">Select visible</button>
          <button class="btn btn-ghost btn-sm" id="m-desel-vis">Deselect visible</button>
        </div>
      </div>
      <div class="matrix-filters" id="matrix-filters">
        ${fields.map(f => {
          const vals = wizard.values[f] || [];
          return `<div class="mf-group">
            <span class="mf-label">${esc(f)}</span>
            <div class="mf-chips">${vals.map(v => `
              <span class="mf-chip ${wizard.filters[f]?.has(v.name) ? 'on' : ''}"
                    data-field="${esc(f)}" data-val="${esc(v.name)}">${esc(v.name)}</span>
            `).join('')}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="wizard-section-sub" style="margin:10px 0 0">
      <span id="matrix-sub-text"></span>
    </div>
    <div class="table-wrapper" style="margin-top:10px">
      <table class="schedule-table">
        <thead><tr>
          <th class="col-check"><input type="checkbox" id="matrix-all" title="Select / deselect all visible"></th>
          ${fields.map(f => `<th>${esc(f)}</th>`).join('')}
        </tr></thead>
        <tbody id="matrix-tbody"></tbody>
      </table>
    </div>
  `;

  refreshTbody();

  // ---- Event wiring ----

  document.getElementById('matrix-groupby').addEventListener('change', e => {
    wizard.groupBy = e.target.value;
    refreshTbody();
  });

  document.getElementById('matrix-filters').addEventListener('click', e => {
    const chip = e.target.closest('.mf-chip');
    if (!chip) return;
    const { field, val } = chip.dataset;
    const fs = wizard.filters[field];
    if (fs.has(val)) fs.delete(val); else fs.add(val);
    chip.classList.toggle('on', fs.has(val));
    refreshTbody();
  });

  document.getElementById('m-sel-vis').addEventListener('click', () => {
    getVisibleIndices().forEach(i => wizard.excluded.delete(i));
    refreshTbody();
  });

  document.getElementById('m-desel-vis').addEventListener('click', () => {
    getVisibleIndices().forEach(i => wizard.excluded.add(i));
    refreshTbody();
  });

  document.getElementById('matrix-all').addEventListener('change', e => {
    const vis = getVisibleIndices();
    if (e.target.checked) vis.forEach(i => wizard.excluded.delete(i));
    else                   vis.forEach(i => wizard.excluded.add(i));
    refreshTbody();
  });

  document.getElementById('matrix-tbody').addEventListener('change', e => {
    const cb = e.target;
    if (cb.dataset.idx !== undefined && !cb.classList.contains('group-cb')) {
      // Individual row checkbox — update in place (avoids scroll reset)
      const idx = +cb.dataset.idx;
      if (cb.checked) wizard.excluded.delete(idx);
      else            wizard.excluded.add(idx);
      cb.closest('tr').classList.toggle('row-excluded', !cb.checked);

      // Update parent group checkbox state if grouped
      if (wizard.groupBy) {
        const gkey = wizard.combos[idx].values[wizard.groupBy]?.name ?? '—';
        const gCb  = document.querySelector(`#matrix-tbody .group-cb[data-gkey="${CSS.escape(gkey)}"]`);
        if (gCb) {
          const vis      = getVisibleIndices();
          const gIndices = vis.filter(i => (wizard.combos[i].values[wizard.groupBy]?.name ?? '—') === gkey);
          const allExcl  = gIndices.every(i => wizard.excluded.has(i));
          const noneExcl = gIndices.every(i => !wizard.excluded.has(i));
          gCb.checked       = noneExcl;
          gCb.indeterminate = !noneExcl && !allExcl;
        }
      }
      updateAllCb();
      updateSubtitle();

    } else if (cb.classList.contains('group-cb')) {
      // Group header checkbox — select/deselect all rows in the group
      const gkey     = cb.dataset.gkey;
      const vis      = getVisibleIndices();
      const gIndices = vis.filter(i => (wizard.combos[i].values[wizard.groupBy]?.name ?? '—') === gkey);
      if (cb.checked) gIndices.forEach(i => wizard.excluded.delete(i));
      else            gIndices.forEach(i => wizard.excluded.add(i));
      refreshTbody();
    }
  });

  $wizardFooter.innerHTML = `
    <button class="btn btn-ghost" id="w-back">← Back</button>
    <button class="btn btn-primary" id="w-next">Create Tables</button>
  `;
  $('w-back').addEventListener('click', async () => { wizard.step = 2; await renderWizardStep(); });
  $('w-next').addEventListener('click', async () => {
    if (selectedCount() === 0) return showToast('Select at least one combination', 'error');
    wizard.step = 4;
    await renderWizardStep();
  });
}

// Step 4 — create columns
async function renderStep4() {
  const activeCombos = wizard.combos.filter((_, i) => !wizard.excluded.has(i));

  $setupBody.innerHTML = `<div class="list-state">Adding ${activeCombos.length} column${activeCombos.length !== 1 ? 's' : ''} to Task Templates…</div>`;
  $wizardFooter.innerHTML = '';

  let success = false;

  try {
    const variables = [...wizard.selected].map(field => ({
      field,
      type: wizard.fields.find(f => f.name === field)?.type ?? 'unknown',
    }));

    const result = await apiFetch('/api/setup/create-matrix', {
      method: 'POST',
      body: JSON.stringify({ variables, combinations: activeCombos }),
    });

    wizard.result = result;
    success = true;

    $setupBody.innerHTML = `
      <div class="wizard-result">
        <div class="wizard-result-icon">✓</div>
        <div class="wizard-result-title">Done</div>
        <div class="wizard-result-row">
          <strong>${esc(result.templatesTable)}</strong>
          <span class="badge">${result.created} added</span>
          ${result.skipped ? `<span class="muted">${result.skipped} already existed</span>` : ''}
        </div>
        <div class="wizard-section-sub" style="margin-top:14px">
          estimates.config.js has been updated. Download the CSV to fill in day estimates offline,
          or edit the columns directly in Airtable, then use Preview Schedule.
        </div>
      </div>
    `;
  } catch (err) {
    $setupBody.innerHTML = `
      <div class="wizard-result">
        <div class="wizard-result-icon err">✗</div>
        <div class="wizard-result-title">Creation failed</div>
        <div class="wizard-section-sub" style="color:var(--err)">${esc(err.message)}</div>
      </div>
    `;
  }

  $wizardFooter.innerHTML = `
    <button class="btn btn-ghost" id="w-back">← Back</button>
    ${success ? `<a class="btn btn-ghost" href="/api/setup/export-csv" download="estimate-matrix.csv">⬇ Download CSV</a>` : ''}
    <button class="btn btn-ghost" id="w-close">Close</button>
  `;
  $('w-back').addEventListener('click', async () => { wizard.step = 3; await renderWizardStep(); });
  $('w-close').addEventListener('click', () => $setupOverlay.classList.remove('open'));
}

// -- Schema modal --

const $schemaOverlay = $('schema-overlay');
const $schemaBtn     = $('schema-btn');
const $schemaClose   = $('schema-close');
const $schemaTabs    = $('schema-tabs');
const $schemaBody    = $('schema-body');

const TYPE_LABEL = {
  text: 'text', number: 'num', date: 'date', link: 'link',
  computed: 'calc', select: 'select', bool: 'bool', user: 'user',
  file: 'file', other: '…',
};

let schemaCache = null;
let activeTabKey = null;

$schemaBtn.addEventListener('click', openSchema);
$schemaClose.addEventListener('click', () => $schemaOverlay.classList.remove('open'));
$schemaOverlay.addEventListener('click', e => {
  if (e.target === $schemaOverlay) $schemaOverlay.classList.remove('open');
});

async function openSchema() {
  $schemaOverlay.classList.add('open');
  if (schemaCache) return renderSchema(schemaCache);

  $schemaTabs.innerHTML = '';
  $schemaBody.innerHTML = '<div class="list-state">Loading schema…</div>';

  try {
    schemaCache = await apiFetch('/api/schema');
    renderSchema(schemaCache);
  } catch (err) {
    $schemaBody.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderSchema(data) {
  const { configured, allTableNames } = data;

  // Build tabs
  $schemaTabs.innerHTML = configured.map(t => `
    <button class="schema-tab${activeTabKey === t.key || (!activeTabKey && t === configured[0]) ? ' active' : ''}"
            data-key="${esc(t.key)}">
      ${esc(t.key)}
      ${t.found ? '' : '<span class="tab-missing">!</span>'}
    </button>
  `).join('');

  if (!activeTabKey) activeTabKey = configured[0]?.key;

  $schemaTabs.querySelectorAll('.schema-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTabKey = btn.dataset.key;
      $schemaTabs.querySelectorAll('.schema-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTableFields(configured.find(t => t.key === activeTabKey), allTableNames);
    });
  });

  renderTableFields(configured.find(t => t.key === activeTabKey) ?? configured[0], allTableNames);
}

function renderTableFields(table, allTableNames) {
  if (!table) { $schemaBody.innerHTML = ''; return; }

  if (!table.found) {
    const suggestions = allTableNames.filter(n =>
      n.toLowerCase().includes(table.key) || table.name.toLowerCase().includes(n.toLowerCase().slice(0, 5))
    ).slice(0, 5);

    $schemaBody.innerHTML = `
      <div class="schema-missing">
        <div class="schema-missing-title">Table not found</div>
        <div class="schema-missing-sub">
          Configured as <code>${esc(table.name)}</code> — set <code>TABLE_${table.key.toUpperCase()}</code>
          in <code>.env</code> to override.
        </div>
        ${suggestions.length ? `
          <div class="schema-missing-sub" style="margin-top:10px">
            Tables in this base: ${suggestions.map(n => `<code>${esc(n)}</code>`).join(', ')}
          </div>` : ''}
      </div>
    `;
    return;
  }

  const isTemplates = table.key === 'templates';
  const fields = table.fields;
  const estimateCols = isTemplates ? fields.filter(f => f.name.includes('Template Estimate')) : [];
  const otherFields  = isTemplates ? fields.filter(f => !f.name.includes('Template Estimate')) : fields;

  function fieldRow(f) {
    const label = TYPE_LABEL[f.category] ?? f.type;
    return `
      <tr>
        <td>${esc(f.name)}</td>
        <td><span class="ftype ftype-${esc(f.category)}">${esc(label)}</span></td>
        <td class="fid">${esc(f.id)}</td>
      </tr>
    `;
  }

  $schemaBody.innerHTML = `
    <div class="schema-table-meta">
      <span class="schema-table-name">${esc(table.name)}</span>
      <span class="badge">${fields.length} field${fields.length !== 1 ? 's' : ''}</span>
      <span class="schema-table-id">${esc(table.id)}</span>
    </div>
    <div class="table-wrapper">
      <table class="schedule-table schema-fields-table">
        <thead>
          <tr><th>Field name</th><th>Type</th><th>Field ID</th></tr>
        </thead>
        <tbody>
          ${otherFields.map(fieldRow).join('')}
          ${estimateCols.length ? `
            <tr class="estimate-group-header">
              <td colspan="3">Estimate columns (${estimateCols.length})</td>
            </tr>
            ${estimateCols.map(fieldRow).join('')}
          ` : ''}
        </tbody>
      </table>
    </div>
  `;
}

// -- CSV Import --

const $csvOverlay    = $('csv-overlay');
const $csvImportBtn  = $('est-csv-import-btn');
const $csvModalClose = $('csv-modal-close');
const $csvBody      = $('csv-body');
const $csvFooter    = $('csv-footer');

const csvState = { headers: null, rows: null, fileName: '' };

$csvImportBtn.addEventListener('click', openCsvImport);
$csvModalClose.addEventListener('click', () => $csvOverlay.classList.remove('open'));
$csvOverlay.addEventListener('click', e => { if (e.target === $csvOverlay) $csvOverlay.classList.remove('open'); });

function openCsvImport() {
  csvState.headers = null;
  csvState.rows    = null;
  csvState.fileName = '';
  $csvOverlay.classList.add('open');
  renderCsvDropzone();
}

function renderCsvDropzone() {
  $csvBody.innerHTML = `
    <div class="csv-dropzone" id="csv-dropzone">
      <div class="csv-drop-icon">⬆</div>
      <div class="csv-drop-label">
        Drop a CSV file here or
        <label for="csv-file-input" class="csv-browse-link">browse</label>
      </div>
      <div class="csv-drop-hint">Use the format exported from the setup wizard (Task column + estimate columns)</div>
      <input type="file" id="csv-file-input" accept=".csv,text/csv" style="display:none">
    </div>
  `;
  $csvFooter.innerHTML = '';

  const dropzone  = document.getElementById('csv-dropzone');
  const fileInput = document.getElementById('csv-file-input');

  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', ()  => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) loadCsvFile(e.dataTransfer.files[0]);
  });
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadCsvFile(fileInput.files[0]); });
}

function loadCsvFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const parsed = parseCSV(e.target.result);
    if (!parsed.length) return showToast('CSV appears to be empty', 'error');
    csvState.headers  = parsed[0];
    csvState.rows     = parsed.slice(1).filter(r => r.some(v => v.trim()));
    csvState.fileName = file.name;
    renderCsvPreview();
  };
  reader.readAsText(file);
}

function parseCSV(raw) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n') + '\n';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cell += c; }
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') {
        row.push(cell); cell = '';
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      } else { cell += c; }
    }
  }
  return rows;
}

function renderCsvPreview() {
  const { headers, rows, fileName } = csvState;
  const taskIdx   = headers.indexOf('Task');
  const estCols   = headers.filter((h, i) => i !== taskIdx && h.trim());
  const nonEmptyRows = rows.filter(r => {
    return estCols.some(h => {
      const v = (r[headers.indexOf(h)] ?? '').trim();
      return v !== '' && !isNaN(parseFloat(v));
    });
  });

  const hasTaskCol = taskIdx !== -1;
  const sampleTasks = rows.slice(0, 5).map(r => esc(r[taskIdx] ?? '—'));

  $csvBody.innerHTML = `
    <div class="csv-preview">
      <div class="csv-preview-file">
        <span class="csv-file-icon">📄</span>
        <span class="csv-file-name">${esc(fileName)}</span>
        <span class="muted">${rows.length} row${rows.length !== 1 ? 's' : ''}</span>
      </div>
      ${!hasTaskCol ? `
        <div class="csv-warning">⚠ No "Task" column found — check the file format</div>
      ` : ''}
      <div class="csv-preview-grid">
        <div class="csv-preview-section">
          <div class="csv-preview-label">Estimate columns detected</div>
          <div class="csv-preview-chips">
            ${estCols.length
              ? estCols.map(h => `<span class="mf-chip on">${esc(h)}</span>`).join('')
              : '<span class="muted">None found</span>'}
          </div>
        </div>
        <div class="csv-preview-section">
          <div class="csv-preview-label">First tasks in file</div>
          <div class="csv-preview-tasks">
            ${sampleTasks.map(t => `<div class="csv-task-row">${t}</div>`).join('')}
            ${rows.length > 5 ? `<div class="muted" style="font-size:11px">+ ${rows.length - 5} more</div>` : ''}
          </div>
        </div>
      </div>
      <div class="csv-preview-summary">
        ${nonEmptyRows.length} of ${rows.length} rows have values to write
      </div>
    </div>
  `;

  $csvFooter.innerHTML = `
    <button class="btn btn-ghost" id="csv-reselect">← Change file</button>
    <button class="btn btn-primary" id="csv-apply" ${!hasTaskCol || !estCols.length ? 'disabled' : ''}>
      Import ${nonEmptyRows.length} row${nonEmptyRows.length !== 1 ? 's' : ''}
    </button>
  `;

  document.getElementById('csv-reselect').addEventListener('click', renderCsvDropzone);
  document.getElementById('csv-apply').addEventListener('click', applyCsvImport);
}

async function applyCsvImport() {
  const { headers, rows } = csvState;
  $csvBody.innerHTML = '<div class="list-state">Writing to Airtable…</div>';
  $csvFooter.innerHTML = '';

  try {
    const result = await apiFetch('/api/setup/import-csv', {
      method: 'POST',
      body: JSON.stringify({ headers, rows }),
    });

    const nf = result.notFound?.length ?? 0;
    $csvBody.innerHTML = `
      <div class="wizard-result">
        <div class="wizard-result-icon">✓</div>
        <div class="wizard-result-title">Import complete</div>
        <div class="wizard-result-row">
          <strong>${result.updated} task${result.updated !== 1 ? 's' : ''} updated</strong>
          <span class="muted">${result.cellsWritten} cell${result.cellsWritten !== 1 ? 's' : ''} written</span>
        </div>
        ${nf ? `
          <div class="csv-warning" style="margin-top:12px">
            ⚠ ${nf} task name${nf !== 1 ? 's' : ''} not matched in Task Templates:
            <div class="csv-notfound">${result.notFound.map(esc).join(', ')}</div>
          </div>` : ''}
      </div>
    `;
  } catch (err) {
    $csvBody.innerHTML = `
      <div class="wizard-result">
        <div class="wizard-result-icon err">✗</div>
        <div class="wizard-result-title">Import failed</div>
        <div class="wizard-section-sub" style="color:var(--err)">${esc(err.message)}</div>
      </div>
    `;
  }

  $csvFooter.innerHTML = `
    <button class="btn btn-ghost" id="csv-reimport">← Import another</button>
    <button class="btn btn-ghost" id="csv-done">Close</button>
  `;
  document.getElementById('csv-reimport').addEventListener('click', openCsvImport);
  document.getElementById('csv-done').addEventListener('click', () => $csvOverlay.classList.remove('open'));
}

// -- Asset Reviews --

const STATUS_COLORS = {
  'Pending':           '#fbbf24',
  'Approved':          '#34d399',
  'Changes Requested': '#f87171',
};

async function loadReviews() {
  const $list = $('reviews-list');
  $list.innerHTML = '<div class="list-state">Loading…</div>';
  try {
    const reviews = await apiFetch('/api/reviews');
    if (!reviews.length) {
      $list.innerHTML = '<div class="list-state">No reviews yet. Submit one from Maya.</div>';
      return;
    }
    $list.innerHTML = reviews.map(r => {
      const color  = STATUS_COLORS[r.status] || '#6b748a';
      const imgSrc = r.screenshot ? `/reviews/${r.screenshot}` : null;
      const date   = r.submittedAt ? new Date(r.submittedAt).toLocaleString() : '—';
      return `
        <div class="review-card" data-id="${esc(r.id)}">
          ${imgSrc ? `<img class="review-thumb" src="${esc(imgSrc)}" alt="screenshot">` : '<div class="review-thumb review-thumb-empty">No screenshot</div>'}
          <div class="review-meta">
            <div class="review-asset">${esc(r.assetName || '—')}</div>
            <div class="review-detail">${esc(r.sceneFile)} · ${esc(r.artist)} · ${esc(date)}</div>
            ${r.notes ? `<div class="review-notes">${esc(r.notes)}</div>` : ''}
          </div>
          <div class="review-actions">
            <span class="review-status" style="color:${color}">${esc(r.status)}</span>
            <select class="review-status-select" data-id="${esc(r.id)}">
              <option value="Pending"           ${r.status === 'Pending'           ? 'selected' : ''}>Pending</option>
              <option value="Approved"          ${r.status === 'Approved'          ? 'selected' : ''}>Approved</option>
              <option value="Changes Requested" ${r.status === 'Changes Requested' ? 'selected' : ''}>Changes Requested</option>
            </select>
          </div>
        </div>
      `;
    }).join('');

    $list.querySelectorAll('.review-status-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const id = sel.dataset.id;
        try {
          await apiFetch(`/api/reviews/${id}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: sel.value }),
          });
          showToast('Status updated', 'info');
          loadReviews();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    $('reviews-list').innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

document.getElementById('reviews-refresh-btn').addEventListener('click', loadReviews);

// -- Init --

$search.addEventListener('input', debounce(e => loadAssets(e.target.value.trim()), 300));

$assetPanel.style.display = 'none';
