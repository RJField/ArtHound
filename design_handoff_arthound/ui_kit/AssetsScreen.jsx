/* global React, StatusPill, Button */
const { useState: useStateAssets } = React;

const ROWS = [
  { id:'A-1142', name:'Hero — Jett · Battlepass IX', type:'Character', priority:1, product:'Valorant', status:'In Review', date:'May 14' },
  { id:'A-1141', name:'KeyArt — Act III splash',     type:'KeyArt',    priority:2, product:'Valorant', status:'Approved',  date:'May 12' },
  { id:'A-1138', name:'Skin — Reaver Vandal v2',     type:'Skin',      priority:2, product:'Valorant', status:'Changes Requested', date:'May 11' },
  { id:'A-1132', name:'VFX — Ult cast pass 3',       type:'VFX',       priority:3, product:'Valorant', status:'In Review', date:'May 10' },
  { id:'A-1130', name:'Voice — Phoenix barks',       type:'Audio',     priority:3, product:'Valorant', status:'Pending',   date:'May 09' },
  { id:'A-1128', name:'Loadscreen — Haven',          type:'KeyArt',    priority:4, product:'Valorant', status:'Approved',  date:'May 09' },
  { id:'A-1124', name:'Card — Spike Rush banner',    type:'KeyArt',    priority:4, product:'Valorant', status:'Pending',   date:'May 08' },
  { id:'A-1119', name:'Anim — Reload, Vandal',       type:'Animation', priority:5, product:'Valorant', status:'In Review', date:'May 07' },
];

const PRIORITY_COLOR = { 1:'var(--ah-p1)', 2:'var(--ah-p2)', 3:'var(--ah-p3)', 4:'var(--ah-p4)', 5:'var(--ah-p5)' };

function FilterChip({ label, summary, on }) {
  return (
    <button className="row gap-1 border" style={{padding:'5px 10px',borderRadius:6,fontSize:12,background:on?'var(--ah-accent-tint)':'transparent',color:on?'var(--ah-accent)':'var(--ah-fg-muted)',borderColor:on?'var(--ah-accent)':'var(--ah-border)'}}>
      <span className="med">{label}</span>
      <span className="t-muted">{summary}</span>
      <span className="t-muted">▾</span>
    </button>
  );
}

function AssetsScreen({ onOpenReviewModal }) {
  const [focused, setFocused] = useStateAssets('A-1142');
  const [selected, setSelected] = useStateAssets(new Set());
  function toggle(id) {
    const n = new Set(selected); n.has(id) ? n.delete(id) : n.add(id); setSelected(n);
  }
  const focusedRow = ROWS.find(r => r.id === focused);

  return (
    <div className="row flex1" style={{minHeight:0}}>
      {/* Sidebar */}
      <aside className="col bg-surface border-r" style={{width:176, padding:'12px 8px', flexShrink:0}}>
        <span className="t-muted upper t-xs semib" style={{padding:'6px 8px'}}>Products</span>
        {['All assets','Valorant','League','TFT','Wild Rift','2XKO'].map((p,i) => (
          <span key={p} className="nav-link" style={{padding:'6px 10px',marginTop:2,background:i===1?'var(--ah-surface-2)':'transparent',color:i===1?'var(--ah-fg)':'var(--ah-fg-muted)'}}>{p}</span>
        ))}
        <span className="t-muted upper t-xs semib" style={{padding:'12px 8px 6px'}}>Saved views</span>
        <span className="nav-link">In review</span>
        <span className="nav-link">Mine — overdue</span>
      </aside>

      {/* Grid + toolbar */}
      <div className="col flex1 border-r" style={{minWidth:0}}>
        <div className="row gap-2 border-b" style={{padding:'8px 12px',flexShrink:0}}>
          <FilterChip label="Status" summary="2 selected" on/>
          <FilterChip label="Priority" summary="All"/>
          <FilterChip label="Type" summary="All"/>
          <span className="t-muted t-xs" style={{marginLeft:8}}>{ROWS.length} assets · {selected.size} selected</span>
          <span style={{flex:1}}/>
          <button className="btn btn-ghost">Columns</button>
          <button className="btn btn-secondary">Generate Work</button>
          <button className="btn btn-primary" onClick={onOpenReviewModal}>+ New Review</button>
        </div>

        <div className="flex1" style={{overflow:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead>
              <tr style={{background:'var(--ah-surface)',position:'sticky',top:0}}>
                <th style={th(36)}><input type="checkbox" style={{accentColor:'var(--ah-accent)'}}/></th>
                <th style={th()}>ID</th>
                <th style={th()}>Name</th>
                <th style={th()}>Type</th>
                <th style={th(60)}>Pri</th>
                <th style={th()}>Product</th>
                <th style={th()}>Status</th>
                <th style={th(80)}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(r => (
                <tr key={r.id}
                  onClick={() => setFocused(r.id)}
                  style={{cursor:'pointer',background:focused===r.id?'var(--ah-accent-tint)':'transparent',borderBottom:'1px solid var(--ah-border-soft)'}}>
                  <td style={td(36)}><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} onClick={e=>e.stopPropagation()} style={{accentColor:'var(--ah-accent)'}}/></td>
                  <td style={td()} className="t-muted tabular" >{r.id}</td>
                  <td style={td()} className="t-fg">{r.name}</td>
                  <td style={td()} className="t-muted">{r.type}</td>
                  <td style={td(60)}><span className="tabular semib" style={{color:PRIORITY_COLOR[r.priority]}}>P{r.priority}</span></td>
                  <td style={td()} className="t-muted">{r.product}</td>
                  <td style={td()}><StatusPill status={r.status}/></td>
                  <td style={td(80)} className="t-muted tabular">{r.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail panel */}
      <aside className="col bg-surface" style={{width:384, padding:20, gap:14, flexShrink:0, overflow:'auto'}}>
        {focusedRow ? (
          <>
            <div className="col gap-1">
              <span className="t-muted upper t-xs semib">Asset</span>
              <span className="t-muted tabular t-xs">{focusedRow.id}</span>
              <h2 className="t-fg t-lg semib" style={{margin:'2px 0 0'}}>{focusedRow.name}</h2>
            </div>
            <div className="row gap-2">
              <StatusPill status={focusedRow.status}/>
              <span className="chip">{focusedRow.type}</span>
              <span className="chip" style={{color:PRIORITY_COLOR[focusedRow.priority]}}>P{focusedRow.priority}</span>
            </div>
            <div className="card" style={{height:160,display:'flex',alignItems:'center',justifyContent:'center',background:'var(--ah-surface-2)'}}>
              <span className="t-muted t-xs">Preview · drag to attach</span>
            </div>
            <div className="col">
              {[
                ['Product', focusedRow.product],
                ['Updated', focusedRow.date],
                ['Owner',   'mira.k'],
                ['Source',  'Jira VAL-1142'],
                ['Reviewers','3'],
              ].map(([k,v]) => (
                <div key={k} className="row" style={{padding:'8px 0',borderBottom:'1px solid var(--ah-border-soft)',gap:16}}>
                  <span className="t-muted t-xs" style={{width:96}}>{k}</span>
                  <span className="t-fg t-sm flex1">{v}</span>
                </div>
              ))}
            </div>
            <div className="row gap-2" style={{marginTop:'auto'}}>
              <Button variant="secondary">Edit</Button>
              <Button variant="primary" onClick={onOpenReviewModal}>+ New Review</Button>
            </div>
          </>
        ) : <span className="t-muted t-sm">Select an asset</span>}
      </aside>
    </div>
  );
}

function th(w){return{textAlign:'left',padding:'8px 12px',fontSize:11,color:'var(--ah-fg-muted)',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.04em',borderBottom:'1px solid var(--ah-border)',whiteSpace:'nowrap',width:w}}
function td(w){return{padding:'8px 12px',whiteSpace:'nowrap',width:w,verticalAlign:'middle'}}

window.AssetsScreen = AssetsScreen;
