/* global React, StatCard */

const BOTS = [
  { icon: '◈', name: 'NumberBot', desc: 'Estimation audits + variance flags', live: true },
  { icon: '✦', name: 'LoreBot',   desc: 'In dev — proceed with caution.',     live: true },
  { icon: '⇄', name: 'OpsBot',    desc: 'Pipeline handoff automation',         live: false },
  { icon: '⊕', name: 'ATCBot',    desc: 'Asset traffic control',               live: false },
];

function StudioHome({ org, onNavigate }) {
  const summary = { asset_count: 12471, product_count: 7, active_shares: 38, work_count: 142, last_synced: '2m ago' };
  const vendorCount = 11;
  return (
    <main className="col gap-8 flex1" style={{padding:32, maxWidth:896, width:'100%'}}>
      <div className="row gap-4">
        <img src="../../assets/ArtHound_logo.png" alt="ArtHound" style={{width:112,height:112,borderRadius:12,objectFit:'cover',flexShrink:0}}/>
        <div className="col gap-1">
          <h1 className="t-fg t-2xl semib" style={{margin:0}}>Welcome, {org}</h1>
          <p className="t-muted t-sm" style={{margin:0}}>Last synced {summary.last_synced}</p>
          <p className="t-xs" style={{margin:0,color:'var(--ah-fg-disabled)'}}>Full reconciliation 18h ago</p>
        </div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(4, 1fr)',gap:12}}>
        <StatCard label="Assets" value={summary.asset_count.toLocaleString()} onClick={() => onNavigate('Assets')}/>
        <StatCard label="Products" value={summary.product_count}/>
        <StatCard label="Active shares" value={summary.active_shares} onClick={() => onNavigate('Shares')}/>
        <StatCard label="Generated work" value={summary.work_count}/>
        <StatCard label="Vendors" value={vendorCount} onClick={() => onNavigate('Vendors')}/>
      </div>

      <div className="card col gap-4" style={{padding:20}}>
        <div className="col gap-2" style={{alignItems:'center',textAlign:'center'}}>
          <img src="../../assets/cutoolu_logo.png" alt="Cu-TOOL-u" style={{width:64,height:64,borderRadius:8,objectFit:'cover'}}/>
          <div className="col">
            <span className="t-fg t-sm semib">Cu-TOOL-u</span>
            <span className="t-muted t-xs">Intelligence beyond mortal comprehension</span>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4, 1fr)',gap:8}}>
          {BOTS.map(bot => (
            <div key={bot.name}
              className={'col gap-1 border ' + (bot.live ? 'card-int' : '')}
              style={{padding:'10px 12px',borderRadius:8,opacity:bot.live?1:0.5,cursor:bot.live?'pointer':'default'}}>
              <div className="row" style={{justifyContent:'space-between'}}>
                <span className="t-accent t-base">{bot.icon}</span>
                <span className={'chip ' + (bot.live ? 'chip-accent' : '')} style={{padding:'1px 8px',fontSize:11}}>{bot.live?'Ask':'Soon'}</span>
              </div>
              <span className="t-fg t-xs med">{bot.name}</span>
              <span className="t-muted t-xs" style={{lineHeight:1.3}}>{bot.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

window.StudioHome = StudioHome;
