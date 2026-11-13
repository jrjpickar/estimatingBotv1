import { measure, factor, deskNames, type Project, type State, type Sheet } from './domain';
import sample from '../samples/interior-demo.pdf?url';

type Stored = Omit<Project,'state'> & {file:Blob; revisions:State[]};
type WorkerEvent = {kind:string;data:unknown};
let worker:Worker|undefined;
let nextJob=0;
const pending=new Map<number,(e:WorkerEvent)=>void>();
function submit(payload:object, onEvent:(e:WorkerEvent)=>void) {
  if(!worker){
    worker=new Worker(new URL('./hosted.worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=({data})=>pending.get(data.job)?.(data);
    worker.onerror=()=>{
      for(const handler of pending.values())handler({kind:'failed',data:'The PDF worker could not start or ran out of memory.'});
      pending.clear();worker?.terminate();worker=undefined;
    };
  }
  const job=++nextJob;
  pending.set(job,e=>{
    onEvent(e);
    if(e.kind==='done'||e.kind==='failed')pending.delete(job);
  });
  worker.postMessage({job,...payload});
}
function extract<T>(payload:object):Promise<T> {
  return new Promise((resolve,reject)=>submit(payload,({kind,data})=>{
    if(kind==='result')resolve(data as T);
    if(kind==='failed')reject(new Error(String(data)));
  }));
}

let db:Promise<IDBDatabase>|undefined;
function database(){
  return db??=new Promise((resolve,reject)=>{
    const open=indexedDB.open('a2z-takeoff-sandbox',1);
    open.onupgradeneeded=()=>{
      const projects=open.result.createObjectStore('projects',{keyPath:'id'});
      projects.createIndex('name','name');
    };
    open.onsuccess=()=>resolve(open.result);
    open.onerror=()=>reject(open.error);
  });
}
async function access<T>(mode:IDBTransactionMode, execute:(store:IDBObjectStore)=>IDBRequest<T>) {
  const conn=await database();
  return new Promise<T>((resolve,reject)=>{
    const tx=conn.transaction('projects',mode);
    const request=execute(tx.objectStore('projects'));
    tx.oncomplete=()=>resolve(request.result);
    tx.onabort=()=>reject(tx.error??request.error);
  });
}
async function list() {
  const conn=await database();
  return new Promise<{id:string;name:string}[]>((resolve,reject)=>{
    const output:{id:string;name:string}[]=[];
    const request=conn.transaction('projects').objectStore('projects').index('name').openKeyCursor();
    request.onsuccess=()=>{
      const cursor=request.result;
      if(!cursor){resolve(output);return;}
      output.push({id:String(cursor.primaryKey),name:String(cursor.key)});cursor.continue();
    };
    request.onerror=()=>reject(request.error);
  });
}
async function save(id:string,state:State) {
  const conn=await database();
  return new Promise<State>((resolve,reject)=>{
    const tx=conn.transaction('projects','readwrite');
    const store=tx.objectStore('projects');
    const read=store.get(id);
    let saved:State;
    read.onsuccess=()=>{
      const p=read.result as Stored;
      if(p.revisions.at(-1)?.revision!==state.revision){
        reject(new Error('A newer revision exists. Reopen the project before saving.'));
        tx.abort();return;
      }
      saved={...state,revision:state.revision+1};
      p.revisions.push(saved);store.put(p);
    };
    tx.oncomplete=()=>resolve(saved);
    tx.onabort=()=>reject(tx.error);
  });
}

function csv(project:Stored,state:State,forPricing=false) {
  const groups=new Map<string,{sheet:number;name:string;unit:'SF'|'LF'|'EA';value:number;cy:number;ids:string[]}>();
  for(const item of state.items){
    if(item.status!=='approved')continue;
    const q=measure(item,state.scales[item.sheet]);
    if(!q)throw new Error('An approved measurement has invalid geometry or scale.');
    const key=`${item.sheet}/${item.scope}`;
    const group=groups.get(key)??{sheet:item.sheet,name:deskNames[item.scope],unit:q.unit,value:0,cy:0,ids:[]};
    group.value+=q.value;group.cy+=q.cy??0;group.ids.push(item.id);groups.set(key,group);
  }
  const rows:(number|string)[][]=[['Takeoff Name','Takeoff Description','Sq Ft','Ln Ft','Cu Yd','EA',
    'Marker Count','Drop Count','Takeoff Quantity','Takeoff Unit','Scale','Plan Name']];
  for(const g of groups.values()){
    const view=project.sheets[g.sheet], scale=factor(state.scales[g.sheet]);
    const fmt=(n:number)=>n.toFixed(6);
    rows.push([g.name,forPricing?'':`Measurement IDs: ${g.ids.join(', ')}`,fmt(g.unit==='SF'?g.value:0),
      fmt(g.unit==='LF'?g.value:0),fmt(g.cy),fmt(g.unit==='EA'?g.value:0),0,0,fmt(g.value),
      {SF:'Sq Ft',LF:'Ln Ft',EA:'EA'}[g.unit],!forPricing&&scale?`${scale.toPrecision(10)} ft/pt`:'',forPricing?`Sheet ${g.sheet+1}`:(view.planName??view.name)]);
  }
  return rows.map(row=>row.map(value=>/[",\r\n]/.test(String(value))?`"${String(value).replaceAll('"','""')}"`:String(value)).join(',')).join('\r\n')+'\r\n';
}

export async function hostedRequest(path:string,init?:RequestInit):Promise<Response> {
  const url=new URL(path,location.origin);
  const method=init?.method??'GET';
  const body=()=>JSON.parse(String(init?.body));
  const json=(value:unknown)=>Response.json(value);
  if(url.pathname==='/api/projects'&&method==='GET')return json(await list());
  if((url.pathname==='/api/projects'||url.pathname==='/api/sample')&&method==='POST'){
    const file=url.pathname==='/api/sample' ? new File([await (await fetch(sample)).blob()],'Interior demolition sample.pdf',{type:'application/pdf'})
      : (init?.body as FormData).get('file');
    if(!(file instanceof File)||await file.slice(0,5).text()!=='%PDF-')throw new Error('Upload a readable PDF.');
    if(file.size>100*1024*1024)throw new Error('PDF exceeds 100 MiB.');
    const id=crypto.randomUUID(), views=await extract<Sheet[]>({action:'sheets',id,file});
    const state:State={revision:0,items:[],rules:{},scales:{},notes:{},markup:null};
    await access('readwrite',s=>s.add({id,file,name:file.name,sheets:views,revisions:[state]}));
    return json({id,name:file.name,sheets:views,state});
  }
  const [, , , id, action, sheet, sub]=url.pathname.split('/');
  const project=await access<Stored|undefined>('readonly',s=>s.get(id));
  if(!project)throw new Error('Project not found in this browser.');
  const {file,name,sheets,revisions}=project;
  if(!action&&method==='GET'){
    const number=url.searchParams.get('revision');
    const state=number===null?revisions.at(-1):revisions[Number(number)];
    if(!state)throw new Error('Revision not found.');
    return json({id,name,sheets,state});
  }
  if(!action&&method==='PUT')return json(await save(id,body()));
  if(action==='pdf')return new Response(file,{headers:{'Content-Type':'application/pdf'}});
  if(action==='csv')return new Response(csv(project,body()),{headers:{'Content-Type':'text/csv'}});
  if(action==='price'){
    const state=body() as State;
    return fetch('/.netlify/functions/price',{
      method:'POST',headers:{'Content-Type':'application/json'},signal:init?.signal,
      body:JSON.stringify({csv:csv(project,state,true),markup:state.markup}),
    });
  }
  const index=Number(sheet);
  if(action!=='sheets'||!Number.isInteger(index)||!sheets[index])throw new Error('Sheet not found.');
  if(sub==='vectors')return json(await extract({action:'vectors',id,file,index}));
  if(sub==='run'){
    const encoder=new TextEncoder();
    let cancelled=false;
    const stream=new ReadableStream<Uint8Array>({
      start(controller){
        submit({action:'run',id,file,index,input:body()},({kind,data})=>{
          if(cancelled)return;
          controller.enqueue(encoder.encode(`event: ${kind}\ndata: ${JSON.stringify(kind==='failed'?{message:data}:data)}\n\n`));
          if(kind==='done'||kind==='failed')controller.close();
        });
      },
      cancel(){cancelled=true;},
    });
    return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
  }
  throw new Error('Action not supported.');
}
