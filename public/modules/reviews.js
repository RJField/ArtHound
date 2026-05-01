import { $, esc, apiFetch, showToast, renderFieldGrid, makeRecordResolver, fieldDisplayString } from './ui.js';

const STATUS_COLORS = {
  'Pending':           '#fbbf24',
  'Approved':          '#34d399',
  'Changes Requested': '#f87171',
};
const STATUS_BG = {
  'Pending':           'rgba(251,191,36,0.12)',
  'Approved':          'rgba(52,211,153,0.12)',
  'Changes Requested': 'rgba(248,113,113,0.12)',
};

const rvState = {
  reviews:       [],
  selected:      null,
  statusOptions: [],
  filters:       { status: new Set(), artist: new Set() },
};

export async function loadReviews() {
  $('rv-list').innerHTML = '<div class="list-state">Loading…</div>';
  renderRvFilters();
  try {
    const [reviews, statusData] = await Promise.all([
      apiFetch('/api/reviews'),
      apiFetch('/api/reviews/status-options').catch(() => ({ options: [] })),
    ]);
    rvState.reviews = reviews;
    rvState.statusOptions = statusData.options;
    rvState.selected = null;
    $('rv-detail').style.display = 'none';
    $('rv-placeholder').style.display = 'flex';
    renderRvFilters();
    renderRvList();
  } catch (err) {
    $('rv-list').innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function getRvFiltered() {
  const { status, artist } = rvState.filters;
  return rvState.reviews.filter(r => {
    if (status.size && !status.has(r.status)) return false;
    if (artist.size && !artist.has(r.artist)) return false;
    return true;
  });
}

function buildRvDropdown(key, label, options, activeSet) {
  const isFiltered = activeSet.size > 0 && activeSet.size < options.length;
  const summary = activeSet.size === 0 || activeSet.size === options.length
    ? 'All'
    : activeSet.size === 1
      ? [...activeSet][0]
      : `${activeSet.size} selected`;
  return `
    <div class="mf-dropdown" data-rv-filter="${key}">
      <button class="mf-dropdown-trigger${isFiltered ? ' mf-filtered' : ''}">
        <span class="mf-label">${esc(label)}</span>
        <span class="mf-dropdown-summary">${esc(summary)}</span>
        <span class="mf-dropdown-arrow">▾</span>
      </button>
      <div class="mf-dropdown-panel">
        <div class="mf-dd-actions">
          <button class="mf-dd-action" data-filter="${key}" data-action="all">All</button>
          <button class="mf-dd-action" data-filter="${key}" data-action="none">None</button>
        </div>
        ${options.length ? options.map(v => `
          <label class="mf-dd-option">
            <input type="checkbox" data-filter="${key}" data-value="${esc(v)}" ${activeSet.has(v) ? 'checked' : ''}>
            ${esc(v)}
          </label>
        `).join('') : '<div class="list-state" style="padding:8px 12px;font-size:12px">No values</div>'}
      </div>
    </div>
  `;
}

function renderRvFilters() {
  const $f = $('rv-filters');
  const allStatuses = [...new Set(rvState.reviews.map(r => r.status).filter(Boolean))].sort();
  const allArtists  = [...new Set(rvState.reviews.map(r => r.artist).filter(Boolean))].sort();

  $f.innerHTML =
    buildRvDropdown('status', 'Status', allStatuses, rvState.filters.status) +
    buildRvDropdown('artist', 'Artist', allArtists,  rvState.filters.artist);

  $f.querySelectorAll('.mf-dropdown-trigger').forEach(trigger => {
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      const dd = trigger.closest('.mf-dropdown');
      const wasOpen = dd.classList.contains('open');
      $f.querySelectorAll('.mf-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!wasOpen) dd.classList.add('open');
    });
  });

  $f.querySelectorAll('.mf-dd-option input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const set = rvState.filters[cb.dataset.filter];
      cb.checked ? set.add(cb.dataset.value) : set.delete(cb.dataset.value);
      renderRvFilters();
      renderRvList();
    });
  });

  $f.querySelectorAll('.mf-dd-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.filter;
      const set = rvState.filters[key];
      set.clear();
      if (btn.dataset.action === 'all') {
        (key === 'status' ? allStatuses : allArtists).forEach(v => set.add(v));
      }
      renderRvFilters();
      renderRvList();
    });
  });
}

function renderRvList() {
  const $list = $('rv-list');
  const filtered = getRvFiltered();
  if (!filtered.length) {
    $list.innerHTML = `<div class="list-state">${rvState.reviews.length ? 'No reviews match filters.' : 'No reviews yet.'}</div>`;
    return;
  }
  $list.innerHTML = filtered.map(r => {
    const color  = STATUS_COLORS[r.status] || '#6b748a';
    const bg     = STATUS_BG[r.status]     || 'rgba(107,116,138,0.12)';
    const date   = r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : '—';
    return `
      <div class="rv-item${rvState.selected === r.id ? ' active' : ''}" data-id="${esc(r.id)}">
        <div class="rv-item-name">${esc(r.assetName || '—')}</div>
        <div class="rv-item-meta">
          <span class="rv-item-status" style="color:${color};background:${bg}">${esc(r.status)}</span>
          <span>${esc(r.artist || '—')}</span>·
          <span>${esc(date)}</span>
        </div>
      </div>
    `;
  }).join('');

  $list.querySelectorAll('.rv-item').forEach(el =>
    el.addEventListener('click', () => selectReview(el.dataset.id))
  );
}

function selectReview(id) {
  rvState.selected = id;
  renderRvList();

  const r = rvState.reviews.find(rv => rv.id === id);
  if (!r) return;

  $('rv-placeholder').style.display = 'none';
  $('rv-detail').style.display = 'flex';

  if (r.screenshot) {
    const mime = (r.screenshotType || '').toLowerCase();
    const isVideo = mime.startsWith('video/') ||
      ['mp4', 'webm', 'mov', 'ogg', 'm4v'].includes(r.screenshot.split('?')[0].split('.').pop().toLowerCase());
    $('rv-screenshot-wrap').innerHTML = isVideo
      ? `<video class="rv-video" src="${esc(r.screenshot)}" controls playsinline preload="metadata"></video>`
      : `<img class="rv-screenshot-img" src="${esc(r.screenshot)}" alt="Attachment">`;
  } else {
    $('rv-screenshot-wrap').innerHTML = '<div class="rv-no-screenshot">No attachment</div>';
  }

  const statusColor = STATUS_COLORS[r.status] || '#6b748a';
  const statusOpts = rvState.statusOptions.length
    ? rvState.statusOptions
    : ['Pending', 'Approved', 'Changes Requested'];
  const optionsHtml = statusOpts
    .map(o => `<option value="${esc(o)}"${r.status === o ? ' selected' : ''}>${esc(o)}</option>`)
    .join('');
  $('rv-actions-bar').innerHTML = `
    <span class="rv-detail-label">Status</span>
    <select class="review-status-select" id="rv-status-select">${optionsHtml}</select>
    <span class="rv-status-pill" style="color:${statusColor}">● ${esc(r.status)}</span>
  `;
  document.getElementById('rv-status-select').addEventListener('change', async function () {
    const newStatus = this.value;
    try {
      await apiFetch(`/api/reviews/${r.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      r.status = newStatus;
      showToast('Status updated', 'info');
      selectReview(id);
      renderRvList();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const RV_SKIP = new Set(['Status', 'Attachments', 'Assets', 'Notes']);
  const rvGridFields = [];

  if (r.assetIds && r.assetIds.length === 1) {
    rvGridFields.push({
      label: 'Asset',
      value: r.assetName || r.assetIds[0],
      type: 'linked-record',
      resolve: makeRecordResolver('assets', r.assetIds[0], r.assetName || r.assetIds[0]),
    });
  } else if (r.assetName) {
    rvGridFields.push({ label: 'Asset', value: r.assetName });
  }

  Object.entries(r.fields || {})
    .filter(([k, v]) => !RV_SKIP.has(k) && v !== '' && v != null)
    .forEach(([k, v]) => rvGridFields.push({ label: k, value: fieldDisplayString(v) }));

  if (r.notes) rvGridFields.push({ label: 'Notes', value: r.notes, span: 'full' });
  renderFieldGrid('rv-fields', rvGridFields);

  loadReviewComments(r.id);
}

async function loadReviewComments(reviewId) {
  $('rv-comments').innerHTML = '<div class="rv-comments-header">Comments</div><div class="list-state" style="font-size:12px;padding:4px 0">Loading…</div>';
  try {
    const comments = await apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}/comments`);
    renderComments(reviewId, comments);
  } catch (err) {
    $('rv-comments').innerHTML = `<div class="rv-comments-header">Comments</div><div class="list-state error" style="font-size:12px">${esc(err.message)}</div>`;
  }
}

function renderComments(reviewId, comments) {
  const listHtml = comments.length
    ? comments.map(c => `
        <div class="rv-comment">
          <div class="rv-comment-meta">
            <span class="rv-comment-author">${esc(c.author?.name || c.author?.email || 'Unknown')}</span>
            <span class="rv-comment-time">${new Date(c.createdTime).toLocaleString()}</span>
          </div>
          <div class="rv-comment-text">${esc(c.text)}</div>
        </div>`).join('')
    : '<div class="rv-comment-empty">No comments yet.</div>';

  $('rv-comments').innerHTML = `
    <div class="rv-comments-header">Comments</div>
    <div class="rv-comments-list">${listHtml}</div>
    <div class="rv-comment-compose">
      <textarea class="rv-comment-input" id="rv-comment-input" placeholder="Add a comment… (Ctrl+Enter to post)"></textarea>
      <div class="rv-comment-compose-footer">
        <span class="rv-comment-hint">Ctrl+Enter to post</span>
        <button class="btn btn-primary btn-sm" id="rv-comment-submit">Post comment</button>
      </div>
    </div>`;

  const $input  = $('rv-comment-input');
  const $submit = $('rv-comment-submit');

  async function postComment() {
    const text = $input.value.trim();
    if (!text) return;
    $submit.disabled = true;
    $input.disabled  = true;
    try {
      await apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      await loadReviewComments(reviewId);
    } catch (err) {
      showToast(err.message, 'error');
      $submit.disabled = false;
      $input.disabled  = false;
    }
  }

  $submit.addEventListener('click', postComment);
  $input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) postComment();
  });
}

document.addEventListener('click', () => {
  const $f = document.getElementById('rv-filters');
  if ($f) $f.querySelectorAll('.mf-dropdown.open').forEach(d => d.classList.remove('open'));
});

document.getElementById('reviews-refresh-btn').addEventListener('click', loadReviews);
