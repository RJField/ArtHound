import { $, esc, apiFetch, showToast } from './ui.js';
import { state } from './state.js';

// -- Vendor Inbox (Incoming Scope) --

export async function loadVendorInbox() {
  $('is-inbox-list').innerHTML = '<div class="list-state">Loading…</div>';
  try {
    const dispatches = await apiFetch('/api/payloads/vendor-inbox');
    renderVendorInbox(dispatches);
  } catch (err) {
    $('is-inbox-list').innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderVendorInbox(dispatches) {
  if (!dispatches.length) {
    $('is-inbox-list').innerHTML = '<div class="list-state">No incoming assets yet</div>';
    return;
  }
  $('is-inbox-list').innerHTML = dispatches.map(d => {
    const data        = d.payload_data?.data ?? {};
    const name        = data['Name'] || data['name'] || '—';
    const itemType    = data['Item Type'] || data['item_type'] || '';
    const priority    = d.payload_data?.priority;
    const studioName  = d.payload_data?.sender_studio_name || 'Unknown Studio';
    const date        = d.created_at ? new Date(d.created_at).toLocaleDateString() : '—';
    return `
      <div class="is-inbox-card">
        <div class="am-asset-info">
          <div class="am-asset-name">${esc(name)}</div>
          <div class="am-asset-meta">
            ${itemType ? `<span class="tag">${esc(itemType)}</span>` : ''}
            ${priority != null ? `<span class="prio prio-${priority}">P${priority}</span>` : ''}
          </div>
        </div>
        <div class="is-inbox-meta">
          <span class="is-inbox-from">${esc(studioName)}</span>
          <span class="is-inbox-date">${esc(date)}</span>
        </div>
      </div>
    `;
  }).join('');
}

$('is-refresh-btn').addEventListener('click', loadVendorInbox);

// -- Send to Vendor wizard --

const sendVendorState = { step: 1, vendorId: null, vendorName: null, vendors: [], existingShares: [] };
const $svOverlay = $('send-vendor-overlay');

function svWizardSteps(active) {
  return ['Vendor', 'Review', 'Send'].map((label, i) => {
    const n   = i + 1;
    const cls = n < active ? 'wstep done' : n === active ? 'wstep active' : 'wstep';
    const num = n < active ? '✓' : String(n);
    const sep = i < 2 ? '<div class="wstep-connector"></div>' : '';
    return `<div class="${cls}"><span class="wstep-num">${num}</span>${label}</div>${sep}`;
  }).join('');
}

function renderSvStep1() {
  $('sv-steps').innerHTML = svWizardSteps(1);

  const sharesHtml = sendVendorState.existingShares.length ? `
    <div class="sv-shares-section">
      <div class="sv-shares-label">Currently shared with</div>
      ${sendVendorState.existingShares.map(d => {
        const vendor = sendVendorState.vendors.find(v => v.id === d.recipient_vendor_id);
        const vName  = vendor?.name ?? 'Unknown Vendor';
        const date   = d.created_at ? new Date(d.created_at).toLocaleDateString() : '—';
        return `
          <div class="sv-share-row">
            <div class="sv-share-info">
              <span class="sv-share-vendor">${esc(vName)}</span>
              <span class="sv-share-date">${esc(date)}</span>
            </div>
            <button class="btn btn-danger btn-sm sv-revoke-btn" data-id="${esc(d.id)}">Revoke</button>
          </div>`;
      }).join('')}
    </div>` : '';

  $('sv-body').innerHTML = `
    <div class="wfs-form-field">
      <label class="wfs-form-label">Send to Vendor</label>
      <select class="wfs-form-input" id="sv-vendor-select">
        <option value="">— Choose a vendor —</option>
        ${sendVendorState.vendors.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}
      </select>
    </div>
    <p style="color:var(--text-muted);font-size:13px;margin:8px 0 0">
      ${state.selectedAssetIds.size} asset${state.selectedAssetIds.size !== 1 ? 's' : ''} selected
    </p>
    ${sharesHtml}
  `;
  $('sv-footer').innerHTML = `
    <button class="btn btn-secondary" id="sv-cancel">Cancel</button>
    <button class="btn btn-primary" id="sv-next" disabled>Next</button>
  `;
  $('sv-cancel').addEventListener('click', closeSendVendorModal);
  $('sv-vendor-select').addEventListener('change', e => {
    const v = sendVendorState.vendors.find(v => v.id === e.target.value);
    sendVendorState.vendorId   = v?.id   ?? null;
    sendVendorState.vendorName = v?.name ?? null;
    $('sv-next').disabled = !sendVendorState.vendorId;
  });
  $('sv-next').addEventListener('click', () => { sendVendorState.step = 2; renderSvStep2(); });
  $('sv-body').querySelectorAll('.sv-revoke-btn').forEach(btn => {
    btn.addEventListener('click', () => revokeShare(btn.dataset.id, btn));
  });
}

async function revokeShare(dispatchId, btn) {
  btn.disabled = true;
  btn.textContent = 'Revoking…';
  try {
    await apiFetch(`/api/payloads/dispatch/${encodeURIComponent(dispatchId)}`, { method: 'DELETE' });
    sendVendorState.existingShares = sendVendorState.existingShares.filter(d => d.id !== dispatchId);
    renderSvStep1();
    showToast('Share revoked', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Revoke';
  }
}

function renderSvStep2() {
  $('sv-steps').innerHTML = svWizardSteps(2);
  const selected = state.assets.filter(a => state.selectedAssetIds.has(a.id));
  $('sv-body').innerHTML = `
    <p style="color:var(--text-muted);font-size:13px;margin:0 0 10px">
      Sending to <strong style="color:var(--text)">${esc(sendVendorState.vendorName)}</strong>:
    </p>
    <div class="sv-asset-list">
      ${selected.map(a => `
        <div class="am-asset-row">
          <div class="am-asset-info">
            <div class="am-asset-name">${esc(a.name || '—')}</div>
            <div class="am-asset-meta">
              <span class="tag">${esc(a.itemType || '—')}</span>
              ${a.priority != null ? `<span class="prio prio-${a.priority}">P${a.priority}</span>` : ''}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
  $('sv-footer').innerHTML = `
    <button class="btn btn-secondary" id="sv-back">Back</button>
    <button class="btn btn-primary" id="sv-send">Send ${selected.length} Asset${selected.length !== 1 ? 's' : ''}</button>
  `;
  $('sv-back').addEventListener('click', () => { sendVendorState.step = 1; renderSvStep1(); });
  $('sv-send').addEventListener('click', dispatchAssetsToVendor);
}

function renderSvStep3(dispatched) {
  $('sv-steps').innerHTML = svWizardSteps(3);
  $('sv-body').innerHTML = `
    <div style="text-align:center;padding:28px 0">
      <div style="font-size:28px;color:var(--ok);margin-bottom:10px">✓</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">${dispatched} asset${dispatched !== 1 ? 's' : ''} sent</div>
      <div style="color:var(--text-muted);font-size:13px">Delivered to ${esc(sendVendorState.vendorName)}</div>
    </div>
  `;
  $('sv-footer').innerHTML = `<button class="btn btn-primary" id="sv-done">Done</button>`;
  $('sv-done').addEventListener('click', closeSendVendorModal);
}

async function dispatchAssetsToVendor() {
  const assets = state.assets
    .filter(a => state.selectedAssetIds.has(a.id) && a.canonicalId)
    .map(a => ({ asset_id: a.canonicalId, asset_data: a.rawFields ?? {} }));

  if (!assets.length) {
    showToast('No assets with canonical IDs — load the Asset Manager first', 'error');
    return;
  }

  const btn = $('sv-send');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const result = await apiFetch('/api/payloads/dispatch-bulk', {
      method: 'POST',
      body: JSON.stringify({ vendor_id: sendVendorState.vendorId, assets }),
    });
    renderSvStep3(result.dispatched);
    showToast(`${result.dispatched} assets sent to ${sendVendorState.vendorName}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = `Send ${assets.length} Asset${assets.length !== 1 ? 's' : ''}`;
  }
}

export async function openSendVendorModal() {
  sendVendorState.step = 1;
  sendVendorState.vendorId = null;
  sendVendorState.vendorName = null;
  sendVendorState.existingShares = [];
  $svOverlay.classList.add('open');
  $('sv-body').innerHTML = '<div class="list-state">Loading…</div>';
  $('sv-footer').innerHTML = '';
  $('sv-steps').innerHTML = svWizardSteps(1);
  try {
    const selectedCanonicalIds = new Set(
      state.assets.filter(a => state.selectedAssetIds.has(a.id) && a.canonicalId).map(a => a.canonicalId)
    );
    const [vendors, outbox] = await Promise.all([
      apiFetch('/api/payloads/vendors'),
      apiFetch('/api/payloads/outbox'),
    ]);
    sendVendorState.vendors = vendors;
    sendVendorState.existingShares = outbox.filter(
      d => selectedCanonicalIds.has(d.asset_id) && !d.revoked_at
    );
    renderSvStep1();
  } catch (err) {
    $('sv-body').innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function closeSendVendorModal() { $svOverlay.classList.remove('open'); }

$('sv-close').addEventListener('click', closeSendVendorModal);
$svOverlay.addEventListener('click', e => { if (e.target === $svOverlay) closeSendVendorModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $svOverlay.classList.contains('open')) closeSendVendorModal();
});
