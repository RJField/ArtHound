import { apiFetch } from './ui.js';

let _mappings = [];   // full list of discovered source fields (from DB)
let _sourceType = 'airtable';

export function initFieldMapping() {
  document.getElementById('settings-btn').addEventListener('click', _load);
  document.getElementById('fm-save-btn').addEventListener('click', _save);
  document.getElementById('fm-sync-btn').addEventListener('click', _resync);
}

async function _load() {
  const wrap   = document.getElementById('fm-table-wrap');
  const status = document.getElementById('fm-status');
  wrap.innerHTML = '<p class="fm-empty">Loading…</p>';
  status.textContent = '';

  try {
    const data = await apiFetch(`/api/sync/field-mapping?source_type=${_sourceType}`);
    _render(data.mappings, data.slots, data.updated_at);
  } catch (e) {
    wrap.innerHTML = `<p class="fm-error">${_esc(e.message || 'Failed to load mappings.')}</p>`;
  }
}

function _render(mappings, slots, updatedAt) {
  const wrap   = document.getElementById('fm-table-wrap');
  const status = document.getElementById('fm-status');

  if (!mappings.length) {
    wrap.innerHTML = '<p class="fm-empty">No source fields found — run a sync first to populate the mapping table.</p>';
    return;
  }

  if (updatedAt) {
    status.textContent = `Last saved: ${new Date(updatedAt).toLocaleString()}`;
  }

  // Build slot → currently assigned source field lookup
  const slotToField = {};
  for (const m of mappings) {
    if (m.arthound_slot) slotToField[m.arthound_slot] = m.source_field_id;
  }

  // Source field options for each dropdown
  const fieldOptions = mappings.map(m =>
    `<option value="${_esc(m.source_field_id)}">${_esc(m.source_field_name)}</option>`
  ).join('');

  // One row per ArtHound slot
  const rows = slots.map(s => {
    const current = slotToField[s.slot] || '';
    return `
      <tr>
        <td class="fm-slot-label">${_esc(s.label)}</td>
        <td>
          <select class="fm-field-select" data-slot="${s.slot}">
            <option value="">— unmapped —</option>
            ${mappings.map(m =>
              `<option value="${_esc(m.source_field_id)}"${m.source_field_id === current ? ' selected' : ''}>${_esc(m.source_field_name)}</option>`
            ).join('')}
          </select>
        </td>
      </tr>
    `;
  }).join('');

  wrap.innerHTML = `
    <table class="fm-table">
      <thead><tr><th>ArtHound slot</th><th>Source field</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  _mappings = mappings;
}

async function _save() {
  const wrap    = document.getElementById('fm-table-wrap');
  const status  = document.getElementById('fm-status');
  const saveBtn = document.getElementById('fm-save-btn');
  const selects = wrap.querySelectorAll('.fm-field-select');

  if (!selects.length) return;

  // Build slot → source_field_id map from the dropdowns
  const slotAssignments = {};
  selects.forEach(sel => {
    if (sel.value) slotAssignments[sel.dataset.slot] = sel.value;
  });

  // Rebuild full mappings array: every source field gets its assigned slot (or null)
  const updated = _mappings.map(m => {
    const slot = Object.entries(slotAssignments).find(([, fid]) => fid === m.source_field_id)?.[0] ?? null;
    return {
      source_field_id:   m.source_field_id,
      source_field_name: m.source_field_name,
      arthound_slot:     slot,
    };
  });

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  status.textContent = '';

  try {
    await apiFetch('/api/sync/field-mapping', {
      method: 'PUT',
      body:   JSON.stringify({ source_type: _sourceType, mappings: updated }),
    });
    _mappings = updated;
    status.textContent = `Saved at ${new Date().toLocaleString()}`;
  } catch (e) {
    status.textContent = _esc(e.message || 'Save failed.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save mapping';
  }
}

async function _resync() {
  const btn    = document.getElementById('fm-sync-btn');
  const status = document.getElementById('fm-status');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  status.textContent = '';

  try {
    await apiFetch('/api/sync/run', {
      method: 'POST',
      body:   JSON.stringify({ source_type: _sourceType, full: true }),
    });
    status.textContent = 'Full sync started — mapping will refresh in a few seconds.';
    setTimeout(_load, 4000);
  } catch (e) {
    status.textContent = _esc(e.message || 'Sync failed to start.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-sync';
  }
}

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
