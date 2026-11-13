import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Viewer } from './Viewer';
import { type Calibration, type Item, type Mode, type Point, type Price, type Project,
  type Rule, type Scope, type State, type Tool, currency, deskNames, distance, factor, json, measure,
  quantity, request, scopeKeys, scopes, toolsFor } from './domain';
import './styles.css';

const names: Record<Mode,string> = {
  select:'Select', pan:'Pan', calibrate:'Calibrate', line:'Line', polyline:'Polyline',
  polygon:'Polygon', rect:'Rectangle', count:'Count',
};
const unitExample: Record<Tool,string> = {
  line:'Click both endpoints.', polyline:'Click each vertex, then press Enter.',
  polygon:'Click each corner, then press Enter.', rect:'Click two opposite corners.', count:'Click one point per item.',
};
const changeScale = (s: State, sheet: number, scale: Calibration): State => ({
  ...s, scales: {...s.scales,[sheet]:scale},
  items:s.items.map(i=>i.sheet===sheet && i.status==='approved' && i.tool!=='count' ? {...i,status:'review'} : i),
});
type Extraction = {paths: {color: string | null; dashed: boolean;
  items: [string,Point[]][]}[]};
const emptyState: State = {revision:0,items:[],scales:{},notes:{},rules:{},markup:null};

async function stream(url: string, body: unknown, handle: (kind: string, data: unknown) => Promise<void>) {
  const response = await request(url,json(body));
  if (!response.body) throw new Error('Live response is unavailable.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '', complete = false;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      pending += value;
      let end: number;
      while ((end=pending.indexOf('\n\n'))>=0) {
        const event=pending.slice(0,end);
        pending=pending.slice(end+2);
        const lines=event.split('\n');
        const kind=lines[0].slice(7);
        const data=JSON.parse(lines[1].slice(6));
        if (kind==='done') complete=true;
        if (kind==='failed') throw new Error(data.message);
        await handle(kind,data);
      }
    }
    if (!complete) throw new Error('The takeoff stream ended early. Review any results received.');
  } finally {
    await reader.cancel();
  }
}

function App() {
  const [projects,setProjects]=useState<{id:string;name:string}[]>([]);
  const [project,setProject]=useState<Project>();
  const [state,setState]=useState<State>(emptyState);
  const [saved,setSaved]=useState<State>(emptyState);
  const [sheet,setSheet]=useState(0);
  const [scope,setScope]=useState<Scope>('wall');
  const [mode,setMode]=useState<Mode>('select');
  const [zoom,setZoom]=useState(1);
  const [snap,setSnap]=useState(true);
  const [hidden,setHidden]=useState<Scope[]>([]);
  const [pending,setPending]=useState<Point[]>([]);
  const [feet,setFeet]=useState('');
  const [selected,setSelected]=useState<string>();
  const [undo,setUndo]=useState<State[]>([]);
  const [redo,setRedo]=useState<State[]>([]);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const rules=state.rules?.[sheet] ?? [];
  const setRules=(next:Rule[])=>commit({...state,rules:{...state.rules,[sheet]:next}});
  const [color,setColor]=useState('#c53344');
  const [dash,setDash]=useState(false);
  const [extraction,setExtraction]=useState<Extraction>();
  const [price,setPrice]=useState<Price|null>(null);
  const [pricing,setPricing]=useState('');
  const [savedRevision,setSavedRevision]=useState('');
  const upload=useRef<HTMLInputElement>(null);
  const dirty=state!==saved;
  const root=project ? `/api/projects/${project.id}` : '';
  const cal=state.scales[sheet];
  const localItems=state.items.filter(i=>i.sheet===sheet);
  const visible=localItems.filter(i=>!hidden.includes(i.scope));
  const item=localItems.find(i=>i.id===selected);
  const vectors=useMemo(()=>extraction?.paths.flatMap(p=>p.items.flatMap(([kind,pts]) =>
    kind==='c' ? [pts[0],pts.at(-1)!] : pts)).slice(0,30000) ?? [],[extraction]);
  const styles=Array.from(new Map(extraction?.paths.filter(p=>p.color)
    .map(p=>[`${p.color}/${p.dashed}`,p] as const)).values());

  const report=(e:unknown)=>setError(e instanceof Error ? e.message : String(e));
  useEffect(()=>{
    request('/api/projects').then(r=>r.json()).then(setProjects).catch(report);
  },[]);
  useEffect(()=>{
    if (!dirty) return;
    const guard=(e:BeforeUnloadEvent)=>e.preventDefault();
    window.addEventListener('beforeunload',guard);
    return ()=>window.removeEventListener('beforeunload',guard);
  },[dirty]);
  useEffect(()=>{
    setExtraction(undefined);
    if (!root) return;
    const ctl=new AbortController();
    request(`${root}/sheets/${sheet}/vectors`,{signal:ctl.signal}).then(r=>r.json())
      .then(setExtraction).catch(e=>{if(!ctl.signal.aborted) report(e);});
    return ()=>ctl.abort();
  },[root,sheet]);
  useEffect(()=>{
    setPrice(null);
    if (!root || !state.items.some(i=>i.status==='approved')) { setPricing(''); return; }
    const ctl=new AbortController();
    setPricing('Calculating approved scope…');
    const timer=window.setTimeout(()=>{
      request(root+'/price',{...json(state),signal:ctl.signal}).then(r=>r.json()).then(result=>{
        setPrice(result); setPricing('');
      }).catch(e=>{if(!ctl.signal.aborted) setPricing(e.message);});
    },220);
    return ()=>{clearTimeout(timer);ctl.abort();};
  },[root,state]);

  function commit(update: State) {
    setUndo(prev=>[...prev.slice(-49),state]);
    setRedo([]);
    setState(update);
  }
  function undoAction() {
    if (!undo.length || busy) return;
    setRedo(prev=>[state,...prev]); setState(undo.at(-1)!); setUndo(undo.slice(0,-1));
    setPending([]); setSelected(undefined);
  }
  function redoAction() {
    if (!redo.length || busy) return;
    setUndo(prev=>[...prev,state]); setState(redo[0]); setRedo(redo.slice(1));
    setPending([]); setSelected(undefined);
  }
  function edit(next: Item) {
    commit({...state,items:state.items.map(i=>i.id===next.id ? next : i)});
  }
  function remove(id: string) {
    commit({...state,items:state.items.filter(i=>i.id!==id)});
    setSelected(undefined);
  }
  function changeMode(m: Mode) {
    setMode(m);setPending([]);setFeet('');setError('');
  }
  function changeScope(s: Scope) {
    setScope(s);setPending([]);
    if (mode!=='select' && mode!=='pan' && mode!=='calibrate' && !toolsFor(s).includes(mode)) {
      setMode(toolsFor(s)[0]);
    }
  }
  function changeSheet(index: number) {
    setSheet(index);setPending([]);setSelected(undefined);setFeet('');
  }
  async function open(endpoint: string, init?: RequestInit) {
    if (dirty && !window.confirm('Discard unsaved takeoff changes?')) return;
    setBusy('Opening plans…');setError('');setNotice('');
    try {
      let p=await (await request(endpoint,init)).json() as Project;
      if (!p.state) p=await (await request(`/api/projects/${p.id}`)).json();
      setProject(p);setState(p.state);setSaved(p.state);changeSheet(0);
      setUndo([]);setRedo([]);setZoom(1);setHidden([]);setSavedRevision('');changeMode('select');
      setProjects(await (await request('/api/projects')).json());
    } catch(e) { report(e); }
    finally { setBusy(''); }
  }
  function finish(tool: Tool, pts: Point[]) {
    if ((tool==='polygon' && pts.length<3) || (tool==='polyline' && pts.length<2)) {
      setError('Add more points before finishing.');return;
    }
    const candidate:Item={id:crypto.randomUUID(),sheet,scope,tool,points:pts,status:'review',
      source:'Manual trace',thickness:null,edited:false};
    const dummy:Calibration={feet:1,points:[[0,0],[1,0]],source:'geometry check'};
    if (!measure(candidate,dummy)) {setError('Trace valid, non-zero geometry.');return;}
    commit({...state,items:[...state.items,candidate]});
    setPending([]);setSelected(candidate.id);setError('');
  }
  function addPoint(p: Point) {
    if (busy) return;
    if (mode==='select' || mode==='pan') return;
    if (mode==='count') { finish(mode,[p]);return; }
    if (mode==='calibrate' && pending.length>=2) return;
    const next=[...pending,p];
    if (mode==='calibrate' && next.length===2 && distance(...next as [Point,Point])===0) {
      setError('Choose two distinct calibration points.');return;
    }
    if (mode!=='calibrate' && (mode==='line' || mode==='rect') && next.length===2) {
      finish(mode,next);return;
    }
    setPending(next);setError('');
  }
  function calibrate() {
    if (pending.length!==2 || !(Number(feet)>0) || !Number.isFinite(Number(feet))) {
      setError('Enter a positive distance in decimal feet.');return;
    }
    const scale: Calibration={points:pending as [Point,Point],feet:Number(feet),source:'Manual calibration'};
    if (!Number.isFinite(factor(scale))) {setError('Scale exceeds the supported range.');return;}
    commit(changeScale(state,sheet,scale));changeMode('select');setNotice('Sheet calibrated.');
  }
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if (busy || (e.target instanceof HTMLElement && /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName))) return;
      if (e.key==='Escape') {setPending([]);setSelected(undefined);}
      if (e.key==='Enter' && (mode==='polygon'||mode==='polyline')) finish(mode,pending);
      if (e.key==='Delete' && item) remove(item.id);
      if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z') {e.preventDefault();if(e.shiftKey)redoAction();else undoAction();}
    };
    window.addEventListener('keydown',key);
    return ()=>window.removeEventListener('keydown',key);
  });

  async function save() {
    setBusy('Saving…');setError('');
    try {
      const result:State=await (await request(root,json(state,'PUT'))).json();
      setState(result);setSaved(result);
      setUndo(prev=>prev.map(s=>({...s,revision:result.revision})));
      setRedo(prev=>prev.map(s=>({...s,revision:result.revision})));
      setNotice(`Saved revision ${result.revision}.`);
    } catch(e) {report(e);}
    finally {setBusy('');}
  }
  async function run() {
    setBusy('Processing sheet…');setError('');setNotice('');setPending([]);setMode('select');
    setUndo(prev=>[...prev.slice(-49),state]);setRedo([]);
    const ids=new Set(state.items.map(i=>i.id));
    const geometryKey=(i:Item)=>JSON.stringify([i.sheet,i.scope,i.points.map(p=>p.map(v=>Math.round(v*10000))).sort()]);
    const existingGeometry=new Set(state.items.map(geometryKey));
    let added=0, skipped=0;
    try {
      await stream(`${root}/sheets/${sheet}/run`,{calibration:cal,rules},async (kind,data)=>{
        if (kind==='scale') setState(prev=>changeScale(prev,sheet,data as Calibration));
        if (kind==='measurement') {
          const candidate=data as Item;
          const key=geometryKey(candidate);
          if (ids.has(candidate.id) || existingGeometry.has(key)) {skipped++;return;}
          ids.add(candidate.id);existingGeometry.add(key);added++;
          setState(prev=>({...prev,items:[...prev.items,candidate]}));
          setHidden(prev=>prev.filter(s=>s!==candidate.scope));
          // Allow completed geometry to paint before consuming the next event.
          if (added <= 12 || added % 8 === 0) await new Promise<void>(resolve=>{
            const timer=window.setTimeout(resolve,100);
            requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));
          });
        }
        if (kind==='warnings') setState(prev=>({...prev,notes:{...prev.notes,[sheet]:data as string[]}}));
      });
      setNotice(`${added} added for review${skipped ? `, ${skipped} already present` : ''}.`);
    } catch(e) {report(e);}
    finally {setBusy('');}
  }
  async function exportCsv() {
    try {
      const blob=await (await request(root+'/csv',json(state))).blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;a.download='A2Z-STACK-takeoff.csv';a.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(e) {report(e);}
  }
  async function restore() {
    const revision=Number(savedRevision);
    if (revision>=state.revision) {setError('Enter an earlier saved revision.');return;}
    setBusy('Loading revision…');setError('');
    try {
      const previous:Project=await (await request(root+'?revision='+revision)).json();
      commit({...previous.state,revision:state.revision});
      setSelected(undefined);setNotice(`Loaded revision ${revision} for review. Save to create a new revision.`);
    } catch(e) {report(e);}
    finally {setBusy('');}
  }
  const linkedScope=item && price?.scopeLines.flatMap(s=>s.lines)
    .find(l=>l.key===`item:${deskNames[item.scope].toLowerCase()}|${scopes[item.scope][1]}`);
  const approved=state.items.filter(i=>i.status==='approved').length;
  const review=state.items.filter(i=>i.status==='review').length;
  const instruction=mode==='calibrate' ? 'Click two points on a known dimension.' :
    mode==='select' ? 'Select a measurement to move it or drag a vertex to resize.' :
    mode==='pan' ? 'Drag to pan the sheet.' : unitExample[mode];

  return <div className="app">
    <header>
      <div className="brand"><strong>A2Z</strong><span>Takeoff Desk</span></div>
      <span className="sandbox-label">LOCAL SANDBOX</span>
      <div className="project-picker">
        {projects.length>0 && <select aria-label="Open saved project" disabled={!!busy}
          value={project?.id ?? ''} onChange={e=>void open('/api/projects/'+e.target.value)}>
          <option value="" disabled>Open saved project</option>
          {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select>}
        <input ref={upload} data-testid="upload" type="file" accept=".pdf,application/pdf" hidden onChange={e=>{
          const file=e.target.files?.[0];e.target.value='';
          if (!file) return;
          const data=new FormData();data.set('file',file);
          void open('/api/projects',{method:'POST',body:data});
        }}/>
        <button onClick={()=>upload.current?.click()} disabled={!!busy}>Upload PDF</button>
        <button onClick={()=>void open('/api/sample',{method:'POST'})} disabled={!!busy}>Open sample</button>
      </div>
    </header>
    {project ? <>
      <fieldset className="toolbar" disabled={!!busy}>
        {(['select','pan','calibrate',...toolsFor(scope)] as Mode[]).map(m=><button key={m}
          className={mode===m?'active':''} aria-pressed={mode===m} onClick={()=>changeMode(m)}>{names[m]}</button>)}
        <span className="divider"/>
        <button onClick={undoAction} disabled={!undo.length}>Undo</button>
        <button onClick={redoAction} disabled={!redo.length}>Redo</button>
        <label className="inline"><input type="checkbox" checked={snap} onChange={e=>setSnap(e.target.checked)}/> Snap</label>
        <div className="toolbar-end">
          <button onClick={()=>void run()}>Run sheet takeoff</button>
          <button className="primary" onClick={()=>void save()}>Save</button>
        </div>
      </fieldset>
      <main className="workspace">
        <fieldset className="panel sidebar" disabled={!!busy}>
          <h2>Sheets</h2>
          <nav className="sheet-list" aria-label="Sheets">
            {project.sheets.map((s,i)=><button key={i} className={i===sheet?'active':''} onClick={()=>changeSheet(i)}>
              <span>{s.name}</span><small>{state.scales[i]?'Calibrated':'Uncalibrated'}</small>
            </button>)}
          </nav>
          <h2>Scope layers</h2>
          {scopeKeys.map(key=><div className={`layer-row ${scope===key?'chosen':''}`} key={key}>
            <input type="checkbox" aria-label={`Show ${scopes[key][0]}`} checked={!hidden.includes(key)}
              onChange={()=>setHidden(hidden.includes(key)?hidden.filter(s=>s!==key):[...hidden,key])}/>
            <button onClick={()=>changeScope(key)} aria-pressed={scope===key}>
              <i style={{background:scopes[key][2]}}/>{scopes[key][0]} <small>{scopes[key][1]}</small>
            </button>
          </div>)}
          <details className="rules">
            <summary>Vector style rules</summary>
            <p>Map a verified demolition stroke color and dash type for this sheet.</p>
            <div className="swatches">
              {styles.slice(0,24).map(p=><button key={p.color+String(p.dashed)} title={`${p.color} ${p.dashed?'dashed':'solid'}`}
                aria-label={`Use ${p.color} ${p.dashed?'dashed':'solid'}`}
                style={{background:p.color!}} onClick={()=>{setColor(p.color!);setDash(p.dashed);}}/>)}
            </div>
            <div className="inline">
              <input aria-label="Stroke color" type="color" value={color} onChange={e=>setColor(e.target.value)}/>
              <label className="inline"><input type="checkbox" checked={dash} onChange={e=>setDash(e.target.checked)}/>Dashed</label>
            </div>
            <button onClick={()=>setRules([...rules,{scope,color,dashed:dash}])}
              disabled={rules.length>=30 || rules.some(r=>r.scope===scope && r.color===color && r.dashed===dash)}>
              Map to {scopes[scope][0]}
            </button>
            {rules.map((r,i)=><div className="rule-row" key={i}><span>{r.color} {r.dashed?'dash':'solid'} · {scopes[r.scope][0]}</span>
              <button aria-label={`Remove rule ${i+1}`} onClick={()=>setRules(rules.filter((_,j)=>i!==j))}>×</button></div>)}
          </details>
        </fieldset>
        <section className="drawing-panel">
          <div className="sheet-bar">
            <div><strong>{project.sheets[sheet].name}</strong><small>{instruction}</small></div>
            <div className="inline">
              <button aria-label="Zoom out" onClick={()=>setZoom(v=>Math.max(.35,v/1.25))}>−</button>
              <button onClick={()=>setZoom(1)} title="Fit width">{Math.round(zoom*100)}%</button>
              <button aria-label="Zoom in" onClick={()=>setZoom(v=>Math.min(6,v*1.25))}>+</button>
            </div>
          </div>
          {mode==='calibrate' && pending.length===2 && <form className="calibrate-bar" onSubmit={e=>{e.preventDefault();calibrate();}}>
            <label>Known distance (ft) <input autoFocus type="number" step="any" min="0" value={feet}
              onChange={e=>setFeet(e.target.value)} required /></label>
            <button className="primary">Apply scale</button>
          </form>}
          {(mode==='polygon'||mode==='polyline') && pending.length>0 && <div className="calibrate-bar">
            <button onClick={()=>finish(mode,pending)}>Finish trace</button><button onClick={()=>setPending(pending.slice(0,-1))}>Remove last point</button>
          </div>}
          <Viewer key={project.id} url={root+'/pdf'} index={sheet} sheet={project.sheets[sheet]} items={visible}
            calibration={cal} mode={busy ? 'select' : mode} activeScope={scope} selected={busy ? undefined : selected} snap={snap}
            zoom={zoom} vertices={vectors} pending={pending} setPending={setPending} addPoint={addPoint}
            select={id=>{if(!busy)setSelected(id);}} changePoints={(id,points)=>{
              const target=state.items.find(i=>i.id===id);
              if (target && !busy) edit({...target,points,status:'review',edited:true});
            }}/>
        </section>
        <fieldset className="panel inspector" disabled={!!busy}>
          <h2>Takeoff review</h2>
          <div className="review-counts"><span>{approved} approved</span><span>{review} in review</span></div>
          <div className="scale-status">{cal ? `${quantity(cal.feet)} ft calibration · ${cal.source}` : 'Sheet scale required for lengths and areas'}</div>
          <div className="measurements">
            {localItems.length===0 && <p>Trace a scope or run sheet takeoff.</p>}
            {localItems.map(i=>{
              const m=measure(i,cal);
              return <button key={i.id} className={i.id===selected?'active':''} onClick={()=>{
                setSelected(i.id);setHidden(hidden.filter(s=>s!==i.scope));changeMode('select');
              }}><i style={{background:scopes[i.scope][2]}}/><span>{scopes[i.scope][0]}
                <small>{i.status} · {i.edited?'edited':i.source.startsWith('Manual')?'manual':'rule match'}</small>
              </span><b>{m?`${quantity(m.value)} ${m.unit}`:'—'}</b></button>;
            })}
          </div>
          {item && <section className="selection">
            <h3>Selected measurement</h3>
            <small>{project.sheets[sheet].name} · {item.source}{item.edited?' · Edited':''}</small>
            {linkedScope && item.status==='approved' && <p>Desk scope · {linkedScope.text}</p>}
            <label>Assigned scope <select value={item.scope} onChange={e=>{
              const target=e.target.value as Scope;
              edit({...item,scope:target,status:'review',edited:true,thickness:target==='slab'?item.thickness:null});
              setHidden(hidden.filter(s=>s!==target));
            }}>{scopeKeys.filter(key=>toolsFor(key).includes(item.tool)).map(key=><option key={key} value={key}>{scopes[key][0]}</option>)}</select></label>
            {item.scope==='slab' && <label>Slab thickness (in) <input type="number" step="any" min="0"
              value={item.thickness ?? ''} onChange={e=>edit({...item,thickness:Number(e.target.value)>0?Number(e.target.value):null,
                status:'review',edited:true})}/></label>}
            {item.scope==='slab' && <p>{item.thickness ? `${quantity(measure(item,cal)?.cy ?? 0)} CY` : 'Enter verified thickness to calculate volume.'}</p>}
            {!measure(item,cal) && <p>Check geometry and sheet scale before approval.</p>}
            <div className="inline wrap">
              <button className="primary" disabled={!measure(item,cal)||item.status==='approved'}
                onClick={()=>edit({...item,status:'approved'})}>Approve</button>
              <button disabled={item.status==='rejected'} onClick={()=>edit({...item,status:'rejected'})}>Reject</button>
              <button onClick={()=>remove(item.id)}>Delete</button>
            </div>
          </section>}
          <details open className="totals"><summary>Approved quantities · all sheets</summary>
            {scopeKeys.map(k=>{
              const values=state.items.filter(i=>i.scope===k && i.status==='approved')
                .map(i=>measure(i,state.scales[i.sheet]));
              const total=values.reduce((a,b)=>a+(b?.value??0),0);
              const cy=values.reduce((a,b)=>a+(b?.cy??0),0);
              return total>0 && <div key={k}><span>{scopes[k][0]}</span><b>{quantity(total)} {scopes[k][1]}{cy>0?` · ${quantity(cy)} CY`:''}</b></div>;
            })}
            {!approved && <p>Approve measurements to include them.</p>}
          </details>
          <details open className="warnings"><summary>Sheet warnings ({state.notes[sheet]?.length??0})</summary>
            {state.notes[sheet]?.map((note,i)=><p key={i}>{note}</p>)}
            {!state.notes[sheet]?.length && <p>{state.notes[sheet]?'No extraction warnings.':'Run takeoff to check this sheet.'}</p>}
          </details>
          <section className="cost">
            <h2>Draft estimate</h2>
            <label>Markup on cost (%) <input type="number" min="0" step="any" placeholder="Desk default"
              value={state.markup===null?'':Number((state.markup*100).toFixed(8))}
              onChange={e=>commit({...state,markup:e.target.value===''?null:Math.max(0,Number(e.target.value))/100})}/></label>
            {price ? <>
              <div className="cost-line"><span>Direct cost</span><b>{currency(price.cost)}</b></div>
              <div className="cost-line bid"><span>Draft bid</span><strong>{currency(price.bid)}</strong></div>
              <details><summary>Labor, hauling and equipment</summary>
                {price.sections.map(s=><section key={s.name}><h3>{s.name} · {currency(s.subtotal)}</h3>
                  {s.lines.map((line,i)=><p key={i}>{line.category} · {line.description} · {quantity(line.qty)} × {currency(line.rate)} = {currency(line.extended)}
                    {line.basis && <small className="basis">{line.basis}</small>}</p>)}
                </section>)}
                {price.warnings.map(w=><p key={w}>{w}</p>)}
              </details>
            </> : <p>{pricing || 'Pricing uses approved quantities and Desk production rates.'}</p>}
            <button disabled={!approved} onClick={()=>void exportCsv()}>Download STACK CSV</button>
          </section>
          {state.revision>0 && <details><summary>Saved revisions</summary>
            <label>Revision <input type="number" min="0" max={state.revision-1} step="1"
              value={savedRevision} onChange={e=>setSavedRevision(e.target.value)}/></label>
            <button disabled={savedRevision===''} onClick={()=>void restore()}>Load earlier revision</button>
          </details>}
        </fieldset>
      </main>
    </> : <main className="empty"><div>
      <h1>Construction takeoff</h1>
      <p>Upload a multipage PDF to calibrate sheets, trace demolition scope, and review draft pricing.</p>
      <button className="primary" disabled={!!busy} onClick={()=>upload.current?.click()}>Choose local PDF</button>
    </div></main>}
    <footer><span>{project ? `Revision ${state.revision}${dirty?' · Unsaved changes':''}` : 'Local project storage'}</span>
      <span role={error?'alert':'status'} className={error?'error':''}>{error || busy || notice}</span></footer>
  </div>;
}

if(import.meta.env.MODE==='netlify')document.documentElement.dataset.hosted='true';
createRoot(document.getElementById('root')!).render(<App/>);
