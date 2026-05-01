import { $, esc, apiFetch, showToast } from './ui.js';

export async function loadShareManager() {
  $('share-manager-content').innerHTML = '<div class="list-state">Loading…</div>';
  try {
    const [dispatches, vendors] = await Promise.all([
      apiFetch('/api/payloads/outbox'),
      apiFetch('/api/payloads/vendors'),
    ]);
    renderShareManager(dispatches, vendors);
  } catch (err) {
    $('share-manager-content').innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderShareManager(dispatches, vendors) {
  const vendorMap = Object.fromEntries(vendors.map(v => [v.id, v.name]));
  const now = new Date();

  if (!dispatches.length) {
    $('share-manager-content').innerHTML = '<div class="list-state">No assets have been shared yet.</div>';
    return;
  }

  const rows = dispatches.map(d => {
    const assetName  = d.payload_data?.data?.['Name'] || d.payload_data?.data?.['name'] || '—';
    const vendorName = vendorMap[d.recipient_vendor_id] || 'Unknown Vendor';
    const sentDate   = d.created_at ? new Date(d.created_at).toLocaleDateString() : '—';
    const expires    = new Date(d.expires_at);
    const viewCount  = d.view_count ?? 0;

    let statusLabel, statusCls;
    if (d.revoked_at) {
      statusLabel = 'Revoked';  statusCls = 'sm-status-revoked';
    } else if (now > expires) {
      statusLabel = 'Expired';  statusCls = 'sm-status-expired';
    } else {
      statusLabel = 'Active';   statusCls = 'sm-status-active';
    }

    const viewLabel = viewCount === 0 ? 'Not viewed' : `Viewed ${viewCount}×`;
    const isRevokable = !d.revoked_at && now <= expires;

    return `
      <div class="sm-row" data-id="${esc(d.id)}">
        <div class="sm-row-main">
          <div class="sm-asset-name">${esc(assetName)}</div>
          <div class="sm-row-meta">
            <span class="sm-vendor">${esc(vendorName)}</span>
            <span class="sm-dot">·</span>
            <span class="sm-sent">Sent ${esc(sentDate)}</span>
            <span class="sm-dot">·</span>
            <span class="${viewCount > 0 ? 'sm-views-seen' : 'sm-views-unseen'}">${esc(viewLabel)}</span>
          </div>
        </div>
        <div class="sm-row-actions">
          <span class="sm-status ${statusCls}">${statusLabel}</span>
          ${isRevokable ? `<button class="btn btn-danger btn-sm sm-revoke-btn" data-id="${esc(d.id)}">Revoke</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  $('share-manager-content').innerHTML = `<div class="sm-list">${rows}</div>`;

  $('share-manager-content').querySelectorAll('.sm-revoke-btn').forEach(btn => {
    btn.addEventListener('click', () => revokeDispatch(btn.dataset.id, btn));
  });
}

async function revokeDispatch(dispatchId, btn) {
  btn.disabled = true;
  btn.textContent = 'Revoking…';
  try {
    await apiFetch(`/api/payloads/dispatch/${encodeURIComponent(dispatchId)}`, { method: 'DELETE' });
    showToast('Access revoked', 'success');
    loadShareManager();
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Revoke';
  }
}
