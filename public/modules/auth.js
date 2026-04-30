import { $, setSupabaseClient, setAuthFailHandler } from './ui.js';
import { state } from './state.js';

let _navigate = null;
let _supabaseClient = null;

export function getSupabaseClient() { return _supabaseClient; }

const $loginError = $('login-error');

function setLoginError(msg) {
  $loginError.textContent = msg || '';
}

function navigateByRole(role) {
  if (role === 'studio') {
    state.homeView = 'home';
    _navigate('home');
  } else if (role === 'vendor') {
    state.homeView = 'vendor-home';
    _navigate('vendor-home');
  } else {
    setLoginError('Account has no role assigned. Contact your administrator.');
  }
}

export function initAuth(navigateFn) {
  _navigate = navigateFn;

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
    navigateByRole(role);
  });

  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('login-btn').click();
  });

  // Logout
  const handleLogout = async () => {
    if (_supabaseClient) await _supabaseClient.auth.signOut();
    _navigate('login');
  };
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('vendor-logout-btn').addEventListener('click', handleLogout);

  // Studio home nav
  document.getElementById('nav-assets').addEventListener('click', () => _navigate('assets'));
  document.getElementById('nav-estimates').addEventListener('click', () => _navigate('estimates'));
  document.getElementById('nav-workflows').addEventListener('click', () => _navigate('workflows'));
  document.getElementById('nav-reviews').addEventListener('click', () => _navigate('reviews'));
  document.getElementById('nav-todos').addEventListener('click', () => _navigate('todos'));

  // Vendor home nav
  document.getElementById('vendor-nav-assets').addEventListener('click', () => _navigate('assets'));
  document.getElementById('vendor-nav-estimates').addEventListener('click', () => _navigate('estimates'));
  document.getElementById('vendor-nav-incoming-scope').addEventListener('click', () => _navigate('incoming-scope'));
  document.getElementById('vendor-nav-todos').addEventListener('click', () => _navigate('todos'));

  // Section back / between-section buttons
  document.getElementById('home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('estimates-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('workflows-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('reviews-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('todos-home-btn').addEventListener('click', () => _navigate(state.homeView));
  document.getElementById('incoming-scope-home-btn').addEventListener('click', () => _navigate(state.homeView));
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
        if (event === 'SIGNED_OUT') _navigate('login');
      });

      const { data: { session } } = await _supabaseClient.auth.getSession();
      if (session) navigateByRole(session.user?.app_metadata?.role);

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
