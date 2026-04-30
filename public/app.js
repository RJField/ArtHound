import { initAuth } from './modules/auth.js';
import { loadProducts, setSendVendorHandler } from './modules/assets.js';
import { loadVendorInbox, openSendVendorModal } from './modules/payload.js';
import { loadMatrixTable, loadPgMatrixTable } from './modules/estimates.js';
import { loadReviews } from './modules/reviews.js';
import { loadWorkflowSteps, initWorkflowSteps } from './modules/workflow-steps.js';
import { loadShareManager } from './modules/shares.js';

setSendVendorHandler(openSendVendorModal);

// -- Navigation --

function navigate(view) {
  document.querySelectorAll('.view').forEach(v => { v.style.display = 'none'; });
  const el = document.getElementById(`view-${view}`);
  el.style.display = 'flex';
  if (view === 'assets') loadProducts();
  if (view === 'reviews') loadReviews();
  if (view === 'incoming-scope') loadVendorInbox();
  if (view === 'matrix-table') loadMatrixTable();
  if (view === 'pg-matrix-table') loadPgMatrixTable();
  if (view === 'workflow-steps') loadWorkflowSteps();
  if (view === 'share-manager') loadShareManager();
}

initAuth(navigate);
initWorkflowSteps(navigate);

document.getElementById('share-manager-refresh-btn').addEventListener('click', loadShareManager);

// Matrix table nav — wired here because they call navigate()
document.getElementById('est-matrix-btn').addEventListener('click', () => navigate('matrix-table'));
document.getElementById('matrix-table-back-btn').addEventListener('click', () => navigate('legacy'));
document.getElementById('matrix-table-refresh-btn').addEventListener('click', loadMatrixTable);
document.getElementById('est-pg-matrix-btn').addEventListener('click', () => navigate('pg-matrix-table'));
document.getElementById('pg-matrix-back-btn').addEventListener('click', () => navigate('estimates'));
document.getElementById('pg-matrix-refresh-btn').addEventListener('click', loadPgMatrixTable);


// -- Init --
