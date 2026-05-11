/* global React */
const { useState } = React;

// ── Topbar ──────────────────────────────────────────────────────────
const STUDIO_NAV = ['Home','Assets','Shares','Reviews','Vendors'];

function Topbar({ active, onNavigate, onSignOut }) {
  return (
    <header className="row gap-4 bg-surface border-b shrink0" style={{height:48, padding:'0 16px'}}>
      <div className="row gap-2" style={{marginRight:8}}>
        <img src="../../assets/ArtHound_logo.png" alt="ArtHound" style={{width:24,height:24,borderRadius:4,objectFit:'cover'}}/>
        <span className="t-fg semib t-sm" style={{letterSpacing:'0.02em'}}>ArtHound</span>
      </div>
      <nav className="row gap-1 flex1">
        {STUDIO_NAV.map(label => (
          <span key={label}
            onClick={() => onNavigate(label)}
            className={'nav-link' + (active === label ? ' active' : '')}>{label}</span>
        ))}
      </nav>
      <div className="row gap-2">
        <span className="nav-link">Settings</span>
        <span className="nav-link">Account</span>
        <span className="nav-link" onClick={onSignOut}>Sign out</span>
      </div>
    </header>
  );
}

// ── Buttons ─────────────────────────────────────────────────────────
function Button({ variant='primary', children, ...rest }) {
  const cls = 'btn btn-' + variant;
  return <button className={cls} {...rest}>{children}</button>;
}

// ── Input / Field ───────────────────────────────────────────────────
function Field({ label, ...rest }) {
  return (
    <div className="col gap-1">
      <label className="t-muted t-xs">{label}</label>
      <input className="input" {...rest} />
    </div>
  );
}

// ── StatCard ────────────────────────────────────────────────────────
function StatCard({ label, value, sub, onClick, loading }) {
  const interactive = onClick ? ' card-int' : '';
  return (
    <div className={'card col gap-1' + interactive}
      style={{padding:'16px 20px', cursor: onClick ? 'pointer' : 'default'}}
      onClick={onClick}>
      <span className="t-muted t-xs">{label}</span>
      {loading
        ? <div className="skeleton" style={{height:28,width:48,marginTop:2}}/>
        : <span className="t-fg t-2xl semib tabular">{value ?? '—'}</span>}
      {sub && !loading && <span className="t-muted t-xs">{sub}</span>}
    </div>
  );
}

// ── Status Pill ─────────────────────────────────────────────────────
const STATUS_CLS = {
  'Pending': 'pill-warning',
  'In Review': 'pill-info',
  'Approved': 'pill-success',
  'Changes Requested': 'pill-error',
};
function StatusPill({ status }) {
  return <span className={'pill ' + (STATUS_CLS[status] || 'chip')}>{status}</span>;
}

// ── Modal shell ─────────────────────────────────────────────────────
function Modal({ title, onClose, children, footer, width=480 }) {
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.60)',backdropFilter:'blur(4px)',zIndex:50,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
      <div className="card shadow-lg col gap-3" style={{width, padding:'20px 22px'}}>
        <div className="row" style={{justifyContent:'space-between'}}>
          <h2 className="t-fg t-sm semib" style={{margin:0}}>{title}</h2>
          <span className="t-muted" style={{cursor:'pointer'}} onClick={onClose}>×</span>
        </div>
        {children}
        {footer && <div className="row gap-2" style={{justifyContent:'flex-end',borderTop:'1px solid var(--ah-border)',paddingTop:10}}>{footer}</div>}
      </div>
    </div>
  );
}

Object.assign(window, { Topbar, Button, Field, StatCard, StatusPill, Modal });
