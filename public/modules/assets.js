import { $, esc, fmtDate, apiFetch, showToast, openDetailModal, closeDetailModal, renderFieldGrid, LINKED_TABLE_MAP, makeRecordResolver } from './ui.js';
import { state } from './state.js';

// -- Asset Manager --

const $amProductList   = $('am-product-list');
const $amNoProduct     = $('am-no-product');
const $amAssetsContent = $('am-assets-content');
const $amProductName   = $('am-product-name');
const $amSelectAll     = $('am-select-all');
const $amAssetList     = $('am-asset-list');
const $amSelCount      = $('am-sel-count');
const $amGenerateBtn   = $('am-generate-btn');
const $amSendVendorBtn = $('am-send-vendor-btn');
const $amGenStatus     = $('am-gen-status');

export async function loadProducts() {
  $amProductList.innerHTML = '<div class="list-state">Loading…</div>';
  try {
    state.products = await apiFetch('/api/assets/products');
    renderProductList();
  } catch (err) {
    $amProductList.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderProductList() {
  if (!state.products.length) {
    $amProductList.innerHTML = '<div class="list-state">No products found</div>';
    return;
  }
  $amProductList.innerHTML = state.products.map(p => `
    <div class="am-product-item${state.selectedProductId === p.id ? ' active' : ''}" data-id="${esc(p.id)}">
      ${esc(p.name)}
    </div>
  `).join('');
  $amProductList.querySelectorAll('.am-product-item').forEach(el => {
    el.addEventListener('click', () => selectProduct(el.dataset.id));
  });
}

async function selectProduct(productId) {
  state.selectedProductId = productId;
  state.selectedAssetIds.clear();
  state.focusedAssetId = null;
  renderProductList();
  updateGenerateBar();
  $('am-tasks-content').innerHTML = '<div class="list-state">Select an asset to view its tasks</div>';
  $('am-meta-content').innerHTML  = '<div class="list-state">Select an asset to view details</div>';

  const product = state.products.find(p => p.id === productId);
  $amProductName.textContent = product?.name ?? '';
  $amSelectAll.checked = false;
  $amAssetList.innerHTML = '<div class="list-state">Loading…</div>';
  $amNoProduct.style.display = 'none';
  $amAssetsContent.style.display = 'flex';

  try {
    state.assets = await apiFetch(`/api/assets?productId=${encodeURIComponent(productId)}`);
    renderAssetList();
  } catch (err) {
    $amAssetList.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderAssetList() {
  if (!state.assets.length) {
    $amAssetList.innerHTML = '<div class="list-state">No assets for this product</div>';
    return;
  }
  $amAssetList.innerHTML = state.assets.map(a => `
    <div class="am-asset-row${state.focusedAssetId === a.id ? ' am-asset-focused' : ''}" data-id="${esc(a.id)}">
      <input type="checkbox" class="am-asset-check" data-id="${esc(a.id)}"
             ${state.selectedAssetIds.has(a.id) ? 'checked' : ''}>
      <div class="am-asset-info">
        <div class="am-asset-name" title="${esc(a.name)}">${esc(a.name || '—')}</div>
        <div class="am-asset-meta">
          <span class="tag">${esc(a.itemType || '—')}</span>
          ${a.priority != null ? `<span class="prio prio-${a.priority}">P${a.priority}</span>` : ''}
        </div>
      </div>
    </div>
  `).join('');

  $amAssetList.querySelectorAll('.am-asset-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.type === 'checkbox') return;
      focusAsset(row.dataset.id);
    });
    row.querySelector('.am-asset-check').addEventListener('change', e => {
      toggleAsset(row.dataset.id, e.target.checked);
    });
  });
}

function toggleAsset(id, force) {
  const checked = force !== undefined ? force : !state.selectedAssetIds.has(id);
  if (checked) state.selectedAssetIds.add(id);
  else state.selectedAssetIds.delete(id);

  const row = $amAssetList.querySelector(`.am-asset-row[data-id="${id}"]`);
  if (row) row.querySelector('.am-asset-check').checked = checked;
  $amSelectAll.checked = state.assets.length > 0 && state.assets.every(a => state.selectedAssetIds.has(a.id));
  updateGenerateBar();
}

async function focusAsset(id) {
  state.focusedAssetId = id;
  renderAssetList();

  const asset = state.assets.find(a => a.id === id);
  state.focusedAsset = asset;
  renderAssetMeta(asset);

  await _fetchAndRenderTasks(id, asset);
}

async function _fetchAndRenderTasks(id, asset) {
  $('am-tasks-content').innerHTML = '<div class="list-state">Loading…</div>';
  try {
    let tasks;
    if (state.taskSource === 'arthound') {
      if (!asset?.canonicalId) {
        $('am-tasks-content').innerHTML = '<div class="list-state">No ArtHound record — asset may not have been synced yet.</div>';
        return;
      }
      tasks = await apiFetch(`/api/schedule/tasks-local?canonicalAssetId=${encodeURIComponent(asset.canonicalId)}`);
    } else {
      const nameParam = asset?.name ? `&assetName=${encodeURIComponent(asset.name)}` : '';
      tasks = await apiFetch(`/api/schedule/tasks?assetId=${encodeURIComponent(id)}${nameParam}`);
    }
    renderAssetTasks(tasks);
  } catch (err) {
    $('am-tasks-content').innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderAssetTasks(tasks) {
  state.lastTasks = tasks;
  if (!tasks.length) {
    $('am-tasks-content').innerHTML = '<div class="list-state">No tasks yet — use Generate Work to create them.</div>';
    return;
  }
  if (state.taskView === 'timeline') {
    renderAssetTasksTimeline(tasks);
  } else {
    renderAssetTasksList(tasks);
  }
}

function renderAssetTasksList(tasks) {
  $('am-tasks-content').innerHTML = tasks.map(t => `
    <div class="am-task-row" data-task-id="${esc(t.id)}" data-task-name="${esc(t.task)}">
      <div>
        <div class="am-task-name">${esc(t.task)}</div>
        <div class="am-task-dates">${esc(t.startDate ? fmtDate(t.startDate) : '—')} → ${esc(t.endDate ? fmtDate(t.endDate) : '—')}</div>
      </div>
      <div class="am-task-estimate">${t.estimate != null ? t.estimate + 'd' : '—'}</div>
    </div>
  `).join('');
}

function renderAssetTasksTimeline(tasks) {
  const dated = tasks
    .filter(t => t.startDate && t.endDate)
    .map(t => ({ ...t, start: new Date(t.startDate), end: new Date(t.endDate) }));

  if (!dated.length) {
    $('am-tasks-content').innerHTML = '<div class="list-state">No dated tasks to display.</div>';
    return;
  }

  const minMs = Math.min(...dated.map(t => t.start.getTime()));
  const maxMs = Math.max(...dated.map(t => t.end.getTime()));
  const rangeMs = maxMs - minMs || 1;

  const pct  = ms    => ((ms - minMs) / rangeMs * 100).toFixed(2);
  const wPct = (s, e) => ((e - s) / rangeMs * 100).toFixed(2);

  const now = Date.now();
  const todayMarker = (now >= minMs && now <= maxMs)
    ? `<div class="am-timeline-today" style="left:${pct(now)}%"></div>`
    : '';

  const months = [];
  const cursor = new Date(new Date(minMs).getFullYear(), new Date(minMs).getMonth(), 1);
  while (cursor.getTime() <= maxMs) {
    const p = Math.max(0, pct(cursor.getTime()));
    months.push(`<span class="am-timeline-month" style="left:${p}%">${cursor.toLocaleString('default', { month: 'short' })} ${cursor.getFullYear()}</span>`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const rows = dated.map(t => `
    <div class="am-timeline-row am-task-row" data-task-id="${esc(t.id)}" data-task-name="${esc(t.task)}">
      <div class="am-timeline-label" title="${esc(t.task)}">${esc(t.task)}</div>
      <div class="am-timeline-track">
        ${todayMarker}
        <div class="am-timeline-bar" style="left:${pct(t.start.getTime())}%;width:${wPct(t.start, t.end)}%">
          ${t.estimate != null ? `<span>${t.estimate}d</span>` : ''}
        </div>
      </div>
    </div>
  `).join('');

  $('am-tasks-content').innerHTML = `
    <div class="am-timeline">
      <div class="am-timeline-header-row">
        <div class="am-timeline-label"></div>
        <div class="am-timeline-track am-timeline-months">
          ${months.join('')}
          ${todayMarker}
        </div>
      </div>
      ${rows}
    </div>
  `;
}

// Event delegation — wired once, survives re-renders.
// ArtHound snapshot tasks have no Airtable record to detail-open.
$('am-tasks-content').addEventListener('click', e => {
  if (state.taskSource === 'arthound') return;
  const row = e.target.closest('.am-task-row[data-task-id]');
  if (row) openTaskDetail(row.dataset.taskId, row.dataset.taskName);
});

function setTaskView(view) {
  state.taskView = view;
  $('am-tasks-list-btn').classList.toggle('active', view === 'list');
  $('am-tasks-timeline-btn').classList.toggle('active', view === 'timeline');
  if (state.lastTasks) renderAssetTasks(state.lastTasks);
}
$('am-tasks-list-btn').addEventListener('click', () => setTaskView('list'));
$('am-tasks-timeline-btn').addEventListener('click', () => setTaskView('timeline'));

function setTaskSource(source) {
  state.taskSource = source;
  $('am-tasks-src-airtable').classList.toggle('active', source === 'airtable');
  $('am-tasks-src-arthound').classList.toggle('active', source === 'arthound');
  if (state.focusedAssetId) _fetchAndRenderTasks(state.focusedAssetId, state.focusedAsset);
}
$('am-tasks-src-airtable').addEventListener('click', () => setTaskSource('airtable'));
$('am-tasks-src-arthound').addEventListener('click', () => setTaskSource('arthound'));

async function openTaskDetail(taskId, taskName) {
  openDetailModal({ title: taskName, fields: [{ label: '', value: 'Loading…' }] });
  try {
    const { fields, displayFields = {} } = await apiFetch(`/api/schedule/tasks/${encodeURIComponent(taskId)}`);
    const SKIP = new Set(['Task']);
    const entries = [];

    for (const [k, v] of Object.entries(fields)) {
      if (SKIP.has(k) || v == null || v === '') continue;

      const isRecArray = Array.isArray(v) && v.length > 0 &&
        v.every(x => typeof x === 'string' && x.startsWith('rec'));

      if (isRecArray) {
        const tableKey = LINKED_TABLE_MAP[k];
        if (tableKey && v.length === 1) {
          const displayName = displayFields[k] || v[0];
          entries.push({
            label: k,
            value: displayName,
            type: 'linked-record',
            resolve: makeRecordResolver(tableKey, v[0], displayName),
          });
        } else {
          const display = displayFields[k] ||
            (tableKey ? `${v.length} linked record${v.length !== 1 ? 's' : ''}` : v.join(', '));
          entries.push({ label: k, value: display });
        }
      } else {
        const display = (displayFields[k] != null && displayFields[k] !== '')
          ? displayFields[k]
          : (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
            ? fmtDate(v.slice(0, 10))
            : String(v);
        entries.push({ label: k, value: display });
      }
    }

    openDetailModal({
      title: taskName,
      fields: entries.length ? entries : [{ label: 'No fields', value: null }],
    });
  } catch (err) {
    closeDetailModal();
    showToast(err.message, 'error');
  }
}

const FIELD_SETTINGS_KEY = 'arthound:assetDetailFields';

const BUILTIN_FIELDS = [
  { key: 'name',        label: 'Name' },
  { key: 'devName',     label: 'Dev Name' },
  { key: 'itemType',    label: 'Item Type' },
  { key: 'product',     label: 'Product' },
  { key: 'team',        label: 'Team' },
  { key: 'priority',    label: 'Priority' },
  { key: 'projectDate', label: 'Project Date' },
  { key: 'assetNumber', label: 'Asset #' },
];

const DEFAULT_BUILTINS = BUILTIN_FIELDS.map(f => f.key);

function loadFieldSettings() {
  try {
    const raw = localStorage.getItem(FIELD_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function saveFieldSettings(settings) {
  localStorage.setItem(FIELD_SETTINGS_KEY, JSON.stringify(settings));
}

function getBuiltinValue(asset, key) {
  if (key === 'priority') return asset.priority != null ? `P${asset.priority}` : null;
  if (key === 'projectDate') return asset.projectDate ? fmtDate(asset.projectDate.slice(0, 10)) : null;
  return asset[key] ?? null;
}

function renderAssetMeta(asset) {
  if (!asset) return;
  const settings = loadFieldSettings();
  const enabledBuiltins = settings ? settings.builtins : DEFAULT_BUILTINS;
  const extras = settings ? (settings.extras || []) : [];

  const fields = [
    ...BUILTIN_FIELDS
      .filter(f => enabledBuiltins.includes(f.key))
      .map(f => {
        const value = getBuiltinValue(asset, f.key);
        if (f.key === 'product' && asset.productId && value) {
          return {
            label: f.label, value,
            type: 'linked-record',
            resolve: makeRecordResolver('products', asset.productId, value),
          };
        }
        return { label: f.label, value };
      })
      .filter(f => f.value != null && f.value !== ''),
    ...extras
      .map(fname => ({ label: fname, value: asset.rawFields?.[fname] ?? null }))
      .filter(f => f.value != null && f.value !== ''),
  ];

  renderFieldGrid('am-meta-content', fields);
}

// -- Field settings modal --

const $fieldSettingsOverlay = $('field-settings-overlay');
const $fieldSettingsBody    = $('field-settings-body');
const $fieldSettingsBtn     = $('am-detail-fields-btn');
const $fieldSettingsClose   = $('field-settings-close');
const $fieldSettingsSave    = $('field-settings-save');

const BUILTIN_AIRTABLE_NAMES = new Set([
  'Name', 'Dev Name', 'ID', 'Product', 'Item Type',
  'Team (from Product)', 'Priority', 'Milestone 4 [Dates]',
]);

$fieldSettingsBtn.addEventListener('click', openFieldSettings);
$fieldSettingsClose.addEventListener('click', () => $fieldSettingsOverlay.classList.remove('open'));
$fieldSettingsOverlay.addEventListener('click', e => {
  if (e.target === $fieldSettingsOverlay) $fieldSettingsOverlay.classList.remove('open');
});

async function openFieldSettings() {
  $fieldSettingsOverlay.classList.add('open');
  $fieldSettingsBody.innerHTML = '<div class="list-state">Loading fields…</div>';

  const settings = loadFieldSettings() || { builtins: [...DEFAULT_BUILTINS], extras: [] };

  let additionalFields = [];
  try {
    const fields = await apiFetch('/api/assets/fields');
    additionalFields = fields.filter(f => !BUILTIN_AIRTABLE_NAMES.has(f.name));
  } catch (_) {
    const allRawNames = new Set();
    state.assets.forEach(a => Object.keys(a.rawFields || {}).forEach(k => allRawNames.add(k)));
    additionalFields = [...allRawNames]
      .filter(name => !BUILTIN_AIRTABLE_NAMES.has(name))
      .sort()
      .map(name => ({ name }));
  }

  $fieldSettingsBody.innerHTML = `
    <div class="field-settings-section">
      <div class="field-settings-section-title">Default Fields</div>
      ${BUILTIN_FIELDS.map(f => `
        <label class="field-settings-item">
          <input type="checkbox" name="builtin" value="${esc(f.key)}"
                 ${settings.builtins.includes(f.key) ? 'checked' : ''}>
          <span>${esc(f.label)}</span>
        </label>
      `).join('')}
    </div>
    ${additionalFields.length ? `
      <div class="field-settings-section">
        <div class="field-settings-section-title">Additional Airtable Fields</div>
        ${additionalFields.map(f => `
          <label class="field-settings-item">
            <input type="checkbox" name="extra" value="${esc(f.name)}"
                   ${settings.extras.includes(f.name) ? 'checked' : ''}>
            <span>${esc(f.name)}</span>
          </label>
        `).join('')}
      </div>
    ` : '<p class="field-settings-hint">No additional fields found.</p>'}
  `;
}

$fieldSettingsSave.addEventListener('click', () => {
  const builtins = [...$fieldSettingsBody.querySelectorAll('input[name="builtin"]:checked')].map(el => el.value);
  const extras   = [...$fieldSettingsBody.querySelectorAll('input[name="extra"]:checked')].map(el => el.value);
  saveFieldSettings({ builtins, extras });
  $fieldSettingsOverlay.classList.remove('open');
  if (state.focusedAsset) renderAssetMeta(state.focusedAsset);
});

$amSelectAll.addEventListener('change', () => {
  const checked = $amSelectAll.checked;
  state.assets.forEach(a => {
    if (checked) state.selectedAssetIds.add(a.id);
    else state.selectedAssetIds.delete(a.id);
  });
  renderAssetList();
  updateGenerateBar();
});

function updateGenerateBar() {
  const n = state.selectedAssetIds.size;
  $amSelCount.textContent = n === 0 ? 'No assets selected' : `${n} asset${n !== 1 ? 's' : ''} selected`;
  $amGenerateBtn.disabled = n === 0;
  $amSendVendorBtn.disabled = n === 0;
  $amGenStatus.innerHTML = '';
}

// Wired by app.js once payload.js is loaded (avoids circular dependency)
let _sendVendorHandler = null;
export function setSendVendorHandler(fn) { _sendVendorHandler = fn; }

$amSendVendorBtn.addEventListener('click', () => _sendVendorHandler?.());

$amGenerateBtn.addEventListener('click', async () => {
  const assetIds = [...state.selectedAssetIds];
  if (!assetIds.length) return;

  $amGenerateBtn.disabled = true;
  $amGenerateBtn.textContent = 'Generating…';
  $amGenStatus.innerHTML = '';

  try {
    const result = await apiFetch('/api/schedule/generate-bulk', {
      method: 'POST',
      body: JSON.stringify({ assetIds }),
    });
    const failMsg = result.failed?.length ? ` · ${result.failed.length} failed` : '';
    const warnMsg = result.warnings?.length ? ` · ${result.warnings.length} steps skipped (no estimate)` : '';
    $amGenStatus.innerHTML = `<span class="status-ok">✓ ${result.created} tasks written${failMsg}${warnMsg}</span>`
      + (result.warnings?.length ? `<ul class="gen-warnings">${result.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '');
    showToast(`${result.created} tasks created for ${assetIds.length} assets`, 'success');
    if (state.focusedAssetId && assetIds.includes(state.focusedAssetId)) {
      await _fetchAndRenderTasks(state.focusedAssetId, state.focusedAsset);
    }
  } catch (err) {
    $amGenStatus.innerHTML = `<span class="status-err">✗ ${esc(err.message)}</span>`;
    showToast(err.message, 'error');
  } finally {
    $amGenerateBtn.disabled = false;
    $amGenerateBtn.textContent = 'Generate Work';
  }
});

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

function renderTableFields(table, allTableNames, target = $schemaBody) {
  if (!table) { target.innerHTML = ''; return; }

  if (!table.found) {
    const suggestions = allTableNames.filter(n =>
      n.toLowerCase().includes(table.key) || table.name.toLowerCase().includes(n.toLowerCase().slice(0, 5))
    ).slice(0, 5);

    target.innerHTML = `
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

  target.innerHTML = `
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
