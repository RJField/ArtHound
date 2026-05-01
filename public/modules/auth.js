import { $, esc, setSupabaseClient, setAuthFailHandler, apiFetch } from './ui.js';
import { state } from './state.js';

let _navigate = null;
let _supabaseClient = null;

export function getSupabaseClient() { return _supabaseClient; }

const $loginError = $('login-error');

function setLoginError(msg) {
  $loginError.textContent = msg || '';
}

const $globalTopbar = document.getElementById('global-topbar');

function navigateByRole(role, triggerSync = false) {
  if (role === 'studio') {
    state.homeView = 'home';
    $globalTopbar.style.display = 'flex';
    _navigate('home');
  } else if (role === 'vendor') {
    state.homeView = 'vendor-home';
    $globalTopbar.style.display = 'flex';
    _navigate('vendor-home');
  } else {
    setLoginError('Account has no role assigned. Contact your administrator.');
    return;
  }
  if (triggerSync) _backgroundSync();
}

function _backgroundSync() {
  apiFetch('/api/sync/run', { method: 'POST', body: JSON.stringify({ source_type: 'airtable' }) })
    .catch(err => console.warn('[ArtHound] Background sync failed to start:', err));
}

function initSignup() {
  const overlay   = document.getElementById('signup-modal-overlay');
  const step1     = document.getElementById('signup-step-role');
  const step2     = document.getElementById('signup-step-creds');
  const step3     = document.getElementById('signup-step-success');
  const nextBtn   = document.getElementById('signup-next-btn');
  const cancelBtn = document.getElementById('signup-cancel-btn');
  const titleEl   = document.getElementById('signup-modal-title');
  const errorEl   = document.getElementById('signup-error');

  let role = null;
  let step = 1;

  function open() {
    role = null;
    step = 1;
    document.querySelectorAll('.signup-role-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('signup-email').value = '';
    document.getElementById('signup-password').value = '';
    document.getElementById('signup-password-confirm').value = '';
    errorEl.textContent = '';
    renderStep();
    overlay.classList.add('open');
  }

  function close() {
    overlay.classList.remove('open');
  }

  function renderStep() {
    step1.style.display = step === 1 ? '' : 'none';
    step2.style.display = step === 2 ? '' : 'none';
    step3.style.display = step === 3 ? '' : 'none';

    cancelBtn.style.display = step === 3 ? 'none' : '';

    if (step === 1) {
      titleEl.textContent = 'Create Account';
      nextBtn.textContent = 'Next';
      nextBtn.disabled = !role;
      cancelBtn.textContent = 'Cancel';
    } else if (step === 2) {
      titleEl.textContent = 'Create Account';
      nextBtn.textContent = 'Create Account';
      nextBtn.disabled = false;
      cancelBtn.textContent = 'Back';
    } else {
      titleEl.textContent = 'Account Created';
      nextBtn.textContent = 'Done';
      nextBtn.disabled = false;
    }
  }

  document.querySelectorAll('.signup-role-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.signup-role-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      role = btn.dataset.role;
      nextBtn.disabled = false;
    });
  });

  nextBtn.addEventListener('click', async () => {
    if (step === 1) {
      step = 2;
      renderStep();
    } else if (step === 2) {
      await handleCreate();
    } else {
      close();
    }
  });

  cancelBtn.addEventListener('click', () => {
    if (step === 2) {
      errorEl.textContent = '';
      step = 1;
      renderStep();
    } else {
      close();
    }
  });

  document.getElementById('signup-modal-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('create-account-btn').addEventListener('click', open);

  async function handleCreate() {
    if (!_supabaseClient) { errorEl.textContent = 'App not ready — please wait.'; return; }

    const email   = document.getElementById('signup-email').value.trim();
    const pw      = document.getElementById('signup-password').value;
    const confirm = document.getElementById('signup-password-confirm').value;

    if (!email || !pw)  { errorEl.textContent = 'Email and password are required.'; return; }
    if (pw !== confirm) { errorEl.textContent = 'Passwords do not match.'; return; }
    if (pw.length < 6)  { errorEl.textContent = 'Password must be at least 6 characters.'; return; }

    nextBtn.disabled = true;
    nextBtn.textContent = 'Creating…';
    errorEl.textContent = '';

    const { data, error } = await _supabaseClient.auth.signUp({
      email,
      password: pw,
      options: { data: { role } }
    });

    if (error) {
      errorEl.textContent = error.message;
      nextBtn.disabled = false;
      nextBtn.textContent = 'Create Account';
      return;
    }

    const needsConfirm = !data.session;
    document.getElementById('signup-success-msg').textContent = needsConfirm
      ? `A confirmation link has been sent to ${email}. Click the link to activate your account, then sign in.`
      : 'Your account is ready — you can now sign in.';

    step = 3;
    renderStep();
  }
}

async function _renderUserModal($body) {
  $body.innerHTML = '<div class="list-state">Loading…</div>';
  try {
    const [me, orgs] = await Promise.all([
      apiFetch('/api/user/me'),
      apiFetch('/api/user/orgs'),
    ]);

    const roleLabel = me.role === 'studio' ? 'Studio' : 'Vendor';
    const currentOrgName = me.org ? me.org.name : 'None assigned';
    const currentOrgId   = me.org ? me.org.id   : '';

    $body.innerHTML = `
      <div style="margin-bottom:16px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:4px">Email</div>
        <div style="font-weight:500">${esc(me.email)}</div>
      </div>
      <div style="margin-bottom:24px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:4px">Role</div>
        <div style="font-weight:500">${esc(roleLabel)}</div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:20px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:4px">Assigned ${esc(roleLabel)}</div>
        <div style="font-weight:500;margin-bottom:20px">${esc(currentOrgName)}</div>

        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:8px">
          Change ${esc(roleLabel)}
        </div>

        <!-- TEMPORARY: Manual org assignment for pre-onboarding dev use.
             Replace with a proper studio/vendor invite and onboarding flow.
             This should not be user-facing in production. -->
        <div style="display:flex;gap:8px;align-items:center">
          <select id="user-assign-select" class="login-input" style="flex:1;height:36px;cursor:pointer;padding:0 10px">
            <option value="">— Select ${esc(roleLabel)} —</option>
            ${orgs.map(o => `<option value="${esc(o.id)}"${o.id === currentOrgId ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" id="user-assign-save">Save</button>
        </div>
        <div id="user-assign-msg" style="font-size:12px;min-height:1.4em;margin-top:8px"></div>
      </div>
    `;

    document.getElementById('user-assign-save').addEventListener('click', async () => {
      const orgId = document.getElementById('user-assign-select').value;
      const $msg  = document.getElementById('user-assign-msg');
      if (!orgId) {
        $msg.style.color = 'var(--err)';
        $msg.textContent = `Select a ${roleLabel.toLowerCase()} first.`;
        return;
      }
      $msg.style.color = 'var(--text-muted)';
      $msg.textContent = 'Saving…';
      try {
        await apiFetch('/api/user/assign', { method: 'POST', body: JSON.stringify({ org_id: orgId }) });
        $msg.style.color = 'var(--ok)';
        $msg.textContent = 'Saved. Sign out and back in to apply.';
      } catch {
        $msg.style.color = 'var(--err)';
        $msg.textContent = 'Failed to save. Try again.';
      }
    });

    if (me.email === 'rjfield@pm.me') {
      const $admin = document.createElement('div');
      $admin.style.cssText = 'border-top:1px solid var(--border);padding-top:20px;margin-top:4px';
      $admin.innerHTML = `
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:8px">Admin</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.5">
          Reconcile ArtHound task snapshots against live Airtable records.
          Soft-deletes any snapshot whose Airtable task no longer exists.
        </div>
        <button class="btn btn-secondary btn-sm" id="user-reconcile-btn">Reconcile Tasks</button>
        <div id="user-reconcile-msg" style="font-size:12px;min-height:1.4em;margin-top:8px"></div>
      `;
      $body.appendChild($admin);

      document.getElementById('user-reconcile-btn').addEventListener('click', async () => {
        const $btn = document.getElementById('user-reconcile-btn');
        const $msg = document.getElementById('user-reconcile-msg');
        $btn.disabled = true;
        $btn.textContent = 'Running…';
        $msg.style.color = 'var(--text-muted)';
        $msg.textContent = '';
        try {
          const result = await apiFetch('/api/schedule/reconcile-tasks', { method: 'POST' });
          $msg.style.color = 'var(--ok)';
          $msg.textContent = `Checked ${result.checked} — ${result.soft_deleted} soft-deleted.`;
        } catch {
          $msg.style.color = 'var(--err)';
          $msg.textContent = 'Reconciliation failed.';
        } finally {
          $btn.disabled = false;
          $btn.textContent = 'Reconcile Tasks';
        }
      });
    }

  } catch {
    $body.innerHTML = '<div class="list-state" style="color:var(--err)">Failed to load account info.</div>';
  }
}

export function initAuth(navigateFn) {
  _navigate = navigateFn;

  initSignup();

  // Login
  document.getElementById('login-btn').addEventListener('click', async () => {
    if (!_supabaseClient) { setLoginError('App not ready — please wait.'); return; }
    setLoginError('');
    const email    = $('login-username').value.trim();
    const password = $('login-password').value;
    if (!email || !password) { setLoginError('Email and password are required.'); return; }

    const { data, error } = await _supabaseClient.auth.signInWithPassword({ email, password });
    if (error) { setLoginError(error.message); return; }

    const role = data.user?.app_metadata?.role;
    if (!role) {
      await _supabaseClient.auth.signOut();
      setLoginError('Account has no role assigned. Contact your administrator.');
      return;
    }
    navigateByRole(role, true);
  });

  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('login-btn').click();
  });

  // Logout
  const handleLogout = async () => {
    $globalTopbar.style.display = 'none';
    if (_supabaseClient) await _supabaseClient.auth.signOut();
    _navigate('login');
  };
  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  // Studio home nav
  document.getElementById('nav-assets').addEventListener('click', () => _navigate('asset-hub'));
  document.getElementById('nav-estimates').addEventListener('click', () => _navigate('estimates'));
  document.getElementById('nav-workflows').addEventListener('click', () => _navigate('workflows'));
  document.getElementById('nav-reviews').addEventListener('click', () => _navigate('reviews'));
  document.getElementById('nav-todos').addEventListener('click', () => _navigate('todos'));
  document.getElementById('nav-legacy').addEventListener('click', () => _navigate('legacy'));

  // User / Settings modals
  const $userOverlay     = document.getElementById('user-modal-overlay');
  const $settingsOverlay = document.getElementById('settings-modal-overlay');
  const $userModalBody   = document.getElementById('user-modal-body');

  document.getElementById('user-btn').addEventListener('click', async () => {
    $userOverlay.classList.add('open');
    await _renderUserModal($userModalBody);
  });
  document.getElementById('user-modal-close').addEventListener('click', () => $userOverlay.classList.remove('open'));
  $userOverlay.addEventListener('click', e => { if (e.target === $userOverlay) $userOverlay.classList.remove('open'); });
  document.getElementById('settings-btn').addEventListener('click', () => $settingsOverlay.classList.add('open'));
  document.getElementById('settings-modal-close').addEventListener('click', () => $settingsOverlay.classList.remove('open'));
  $settingsOverlay.addEventListener('click', e => { if (e.target === $settingsOverlay) $settingsOverlay.classList.remove('open'); });

  // Vendor home nav
  document.getElementById('vendor-nav-assets').addEventListener('click', () => _navigate('assets'));
  document.getElementById('vendor-nav-estimates').addEventListener('click', () => _navigate('estimates'));
  document.getElementById('vendor-nav-incoming-scope').addEventListener('click', () => _navigate('incoming-scope'));
  document.getElementById('vendor-nav-todos').addEventListener('click', () => _navigate('todos'));

  // Section back / between-section buttons
  document.getElementById('home-btn').addEventListener('click', () => _navigate('asset-hub'));
  document.getElementById('asset-hub-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('asset-hub-viewer-btn').addEventListener('click', () => _navigate('assets'));
  document.getElementById('asset-hub-shares-btn').addEventListener('click', () => _navigate('share-manager'));
  document.getElementById('share-manager-back-btn').addEventListener('click', () => _navigate('asset-hub'));
  document.getElementById('estimates-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('workflows-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('reviews-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('todos-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('incoming-scope-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('legacy-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('wfs-manage-btn').addEventListener('click', () => _navigate('workflow-steps'));
  document.getElementById('wf-steps-back-btn').addEventListener('click', () => _navigate('workflows'));

  // Bootstrap Supabase
  fetch('/api/config')
    .then(r => r.json())
    .then(async ({ airtableUrl, supabaseUrl, supabaseAnonKey }) => {
      _supabaseClient = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
      setSupabaseClient(_supabaseClient);
      setAuthFailHandler(() => _navigate('login'));

      _supabaseClient.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') {
          $globalTopbar.style.display = 'none';
          _navigate('login');
        }
      });

      const { data: { session } } = await _supabaseClient.auth.getSession();
      if (session) navigateByRole(session.user?.app_metadata?.role, true);

      const wireAirtable = (id) => {
        const btn = document.getElementById(id);
        if (airtableUrl) {
          btn.addEventListener('click', () => window.open(airtableUrl, '_blank', 'noopener'));
        } else {
          btn.disabled = true;
          btn.title = 'AIRTABLE_BASE_ID not configured';
        }
      };
      wireAirtable('nav-airtable');
      wireAirtable('vendor-nav-airtable');
    })
    .catch(() => setLoginError('Failed to load app config. Is the server running?'));
}
