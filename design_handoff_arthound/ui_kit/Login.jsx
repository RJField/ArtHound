/* global React, Field, Button */
const { useState: useStateLogin } = React;

function Login({ onSignIn }) {
  const [email, setEmail] = useStateLogin('m@studio.gg');
  const [password, setPassword] = useStateLogin('••••••••');
  const [busy, setBusy] = useStateLogin(false);

  function handle(e) {
    e.preventDefault();
    setBusy(true);
    setTimeout(() => { setBusy(false); onSignIn(email); }, 400);
  }

  return (
    <div style={{position:'relative',minHeight:'100%',display:'flex',alignItems:'center',justifyContent:'center',padding:32,overflow:'hidden'}}>
      <div style={{position:'absolute',inset:0,backgroundImage:'url(../../assets/ArtHound_logo.png)',backgroundSize:'contain',backgroundRepeat:'no-repeat',backgroundPosition:'center',opacity:0.10,pointerEvents:'none'}}/>
      <form onSubmit={handle} className="card col gap-4" style={{padding:32,width:'100%',maxWidth:384,position:'relative'}}>
        <h1 className="t-fg semib" style={{fontSize:20,margin:0}}>ArtHound</h1>
        <Field label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus/>
        <Field label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required/>
        <button type="submit" disabled={busy} className="btn btn-primary" style={{padding:'8px 16px',borderRadius:8,fontSize:14,opacity:busy?0.5:1}}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" className="t-muted t-xs" style={{background:'none',border:0,cursor:'pointer',textAlign:'center'}}>Create account</button>
        <p className="t-muted t-xs" style={{textAlign:'center',margin:'8px 0 0'}}>© 2026 FieldTech. All rights reserved.</p>
      </form>
    </div>
  );
}

window.Login = Login;
