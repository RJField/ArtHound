import { $, esc, apiFetch, showToast } from './ui.js';
import { getSupabaseClient } from './auth.js';

let _navigate = null;
export function initWorkflowSteps(navigateFn) { _navigate = navigateFn; }

const wfsState = { steps: [], selectedId: null };

export async function loadWorkflowSteps() {
  const $list = $('wfs-list');
  $list.innerHTML = '<div class="list-state">Loading…</div>';
  wfsState.selectedId = null;
  _updateWfsButtons();
  try {
    wfsState.steps = await apiFetch('/api/workflow-steps');
    _renderWfsList();
  } catch (err) {
    $list.innerHTML = `<div class="list-state">${esc(err.message)}</div>`;
  }
}

function _renderWfsList() {
  const $list = $('wfs-list');
  if (!wfsState.steps.length) {
    $list.innerHTML = '<div class="list-state">No workflow steps yet. Click + Add to create one.</div>';
    return;
  }

  const steps    = wfsState.steps;
  const stepById = Object.fromEntries(steps.map(s => [s.id, s]));

  // Topological sort (Kahn's) so dependency-first order is established
  const followers = new Map(steps.map(s => [s.id, []]));
  const inDegree  = new Map(steps.map(s => [s.id, 0]));
  for (const s of steps) {
    for (const dep of s.depends_on) {
      if (followers.has(dep.id)) {
        followers.get(dep.id).push(s.id);
        inDegree.set(s.id, inDegree.get(s.id) + 1);
      }
    }
  }
  const queue  = steps.filter(s => inDegree.get(s.id) === 0).map(s => s.id);
  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    for (const next of (followers.get(id) || [])) {
      const deg = inDegree.get(next) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  for (const s of steps) if (!sorted.includes(s.id)) sorted.push(s.id);

  const craftGroups = new Map();
  for (const id of sorted) {
    const s = stepById[id];
    if (!s) continue;
    const craft = s.craft || '—';
    if (!craftGroups.has(craft)) craftGroups.set(craft, []);
    craftGroups.get(craft).push(s);
  }

  const html = [...craftGroups.entries()].map(([craft, groupSteps]) => {
    const label = craft === '—' ? 'Unassigned' : craft;
    const rows = groupSteps.map(s => {
      const active = wfsState.selectedId === s.id ? ' active' : '';
      const deps = s.depends_on.length
        ? `<div class="wfs-item-deps"><span class="wfs-dep-label">Needs</span>${s.depends_on.map(d => `<span class="wfs-dep-chip">${esc(d.name)}</span>`).join('')}</div>`
        : '';
      return `<div class="wfs-item${active}" data-id="${esc(s.id)}">
        <span class="wfs-item-name">${esc(s.name)}</span>
        ${deps}
      </div>`;
    }).join('');
    return `<div class="wfs-group">
      <div class="wfs-group-header">
        <span class="wfs-group-craft">${esc(label)}</span>
        <span class="wfs-group-count">${groupSteps.length} step${groupSteps.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="wfs-group-steps">${rows}</div>
    </div>`;
  }).join('');

  $list.innerHTML = `<div class="wfs-groups">${html}</div>`;

  $list.querySelectorAll('.wfs-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      wfsState.selectedId = wfsState.selectedId === id ? null : id;
      _renderWfsList();
      _updateWfsButtons();
    });
  });
}

function _updateWfsButtons() {
  const sel = !!wfsState.selectedId;
  $('wfs-edit-btn').disabled   = !sel;
  $('wfs-remove-btn').disabled = !sel;
}

// Add / Edit modal

let _wfsEditMode = null;

function _openWfsModal(mode) {
  _wfsEditMode = mode;
  const step = mode === 'edit' ? wfsState.steps.find(s => s.id === wfsState.selectedId) : null;
  $('wfs-modal-title').textContent = mode === 'add' ? 'Add Workflow Step' : 'Edit Workflow Step';
  $('wfs-name-input').value  = step ? step.name        : '';
  $('wfs-craft-input').value = step ? (step.craft || '') : '';
  const others      = wfsState.steps.filter(s => s.id !== (step ? step.id : null));
  const currentDeps = step ? step.depends_on.map(d => d.id) : [];
  $('wfs-dep-checkboxes').innerHTML = others.length
    ? others.map(s => `<label class="wfs-dep-row"><input type="checkbox" value="${esc(s.id)}"${currentDeps.includes(s.id) ? ' checked' : ''}><span>${esc(s.name)}</span></label>`).join('')
    : '<div class="wfs-dep-empty">No other steps to depend on.</div>';
  $('wfs-edit-overlay').classList.add('open');
  $('wfs-name-input').focus();
}

function _closeWfsModal() {
  $('wfs-edit-overlay').classList.remove('open');
}

$('wfs-add-btn').addEventListener('click', () => _openWfsModal('add'));
$('wfs-edit-btn').addEventListener('click', () => _openWfsModal('edit'));
$('wfs-modal-close').addEventListener('click', _closeWfsModal);
$('wfs-modal-cancel').addEventListener('click', _closeWfsModal);
$('wfs-edit-overlay').addEventListener('click', e => { if (e.target === $('wfs-edit-overlay')) _closeWfsModal(); });

$('wfs-modal-save').addEventListener('click', async () => {
  const name = $('wfs-name-input').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  const craft      = $('wfs-craft-input').value.trim();
  const depends_on = [...$('wfs-dep-checkboxes').querySelectorAll('input:checked')].map(el => el.value);
  const $save = $('wfs-modal-save');
  $save.disabled = true;
  try {
    if (_wfsEditMode === 'add') {
      await apiFetch('/api/workflow-steps', { method: 'POST', body: JSON.stringify({ name, craft, depends_on }) });
      showToast('Step added', 'success');
    } else {
      await apiFetch(`/api/workflow-steps/${wfsState.selectedId}`, { method: 'PATCH', body: JSON.stringify({ name, craft, depends_on }) });
      showToast('Step updated', 'success');
    }
    _closeWfsModal();
    await loadWorkflowSteps();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    $save.disabled = false;
  }
});

// Remove confirm modal

function _openWfsRemoveModal() {
  const step = wfsState.steps.find(s => s.id === wfsState.selectedId);
  if (!step) return;
  $('wfs-remove-msg').textContent = `Remove "${step.name}"? This cannot be undone.`;
  $('wfs-remove-overlay').classList.add('open');
}

function _closeWfsRemoveModal() {
  $('wfs-remove-overlay').classList.remove('open');
}

$('wfs-remove-btn').addEventListener('click', _openWfsRemoveModal);
$('wfs-remove-close').addEventListener('click', _closeWfsRemoveModal);
$('wfs-remove-cancel').addEventListener('click', _closeWfsRemoveModal);
$('wfs-remove-overlay').addEventListener('click', e => { if (e.target === $('wfs-remove-overlay')) _closeWfsRemoveModal(); });

$('wfs-remove-confirm').addEventListener('click', async () => {
  if (!wfsState.selectedId) return;
  const $btn = $('wfs-remove-confirm');
  $btn.disabled = true;
  try {
    await apiFetch(`/api/workflow-steps/${wfsState.selectedId}`, { method: 'DELETE' });
    showToast('Step removed', 'success');
    _closeWfsRemoveModal();
    wfsState.selectedId = null;
    await loadWorkflowSteps();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    $btn.disabled = false;
  }
});

// CSV download

$('wfs-csv-btn').addEventListener('click', async () => {
  try {
    const { data: { session } } = await getSupabaseClient().auth.getSession();
    if (!session) { _navigate?.('login'); return; }
    const res = await fetch('/api/workflow-steps/csv', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'workflow_steps.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, 'error');
  }
});
