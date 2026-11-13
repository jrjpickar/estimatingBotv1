import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Group, Line, Rect, Circle, Text } from 'react-konva';
import type Konva from 'konva';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { type Calibration, type Item, type Mode, type Point, type Sheet, type Scope, distance, scopes, measure, quantity, request } from './domain';

GlobalWorkerOptions.workerSrc = worker;
interface Props {
  url: string; index: number; sheet: Sheet; items: Item[]; calibration?: Calibration;
  mode: Mode; activeScope: Scope; selected?: string; snap: boolean; zoom: number;
  vertices: Point[]; pending: Point[]; setPending: (p: Point[]) => void;
  addPoint: (p: Point) => void; select: (id?: string) => void;
  changePoints: (id: string, points: Point[]) => void;
}
const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));

export function Viewer({ url, index, sheet, items, calibration, mode, activeScope, selected, snap,
  zoom, vertices, pending, setPending, addPoint, select, changePoints }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const drag = useRef<{x:number; y:number; left:number; top:number} | null>(null);
  const [viewport, setViewport] = useState(800);
  const [hover, setHover] = useState<Point>();
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const fit = Math.min(1.65, Math.max(160, viewport-40)/sheet.width);
  const z = fit*zoom;
  const width = sheet.width*z, height = sheet.height*z;
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setViewport(entry.contentRect.width));
    if (scroll.current) observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  const [doc, setDoc] = useState<Awaited<ReturnType<typeof getDocument>['promise']>>();
  useEffect(() => {
    let live = true;
    setDoc(undefined);
    setError('');
    const ctl=new AbortController();
    const options={standardFontDataUrl:'/pdf-assets/standard_fonts/',cMapUrl:'/pdf-assets/cmaps/',
      cMapPacked:true,wasmUrl:'/pdf-assets/wasm/'};
    let task:ReturnType<typeof getDocument>|undefined;
    (async()=>{
      if(import.meta.env.MODE==='netlify'){
        const bytes=await (await request(url,{signal:ctl.signal})).arrayBuffer();
        if(!live)return;
        task=getDocument({...options,data:bytes});
      }else task=getDocument({...options,url});
      const loaded=await task.promise;
      if(live)setDoc(loaded);
    })().catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;ctl.abort();void task?.destroy();};
  }, [url]);
  useEffect(() => {
    if (!doc || !canvas.current) return;
    let live = true;
    let cancel = () => {};
    const element = canvas.current;
    setReady(false);
    setError('');
    doc.getPage(index+1).then(page => {
      if (!live) return;
      const scale = Math.min(z * (window.devicePixelRatio || 1), 4096/Math.max(sheet.width,sheet.height));
      const view = page.getViewport({scale});
      element.width = Math.ceil(view.width);
      element.height = Math.ceil(view.height);
      const task = page.render({canvas:element, viewport:view});
      cancel = () => task.cancel();
      return task.promise.then(() => { if (live) setReady(true); });
    }).catch(e => { if (live) setError(e.message); });
    return () => { live=false; cancel(); };
  }, [doc, index, z, sheet.width, sheet.height]);

  const bounded = (p: Point): Point => [clamp(p[0],sheet.width),clamp(p[1],sheet.height)];
  function snapped(p: Point, ignore?: string) {
    if (!snap) return bounded(p);
    let best = 9/z;
    let result = p;
    const targets = [...vertices, ...items.filter(i => i.id !== ignore).flatMap(i => i.points)];
    for (const target of targets) {
      const d = distance(target,p);
      if (d < best) { best=d; result=target; }
    }
    return bounded(result);
  }
  const pointer = (stage: Konva.Stage): Point | undefined => {
    const p = stage.getPointerPosition();
    return p ? snapped([p.x/z,p.y/z]) : undefined;
  };
  const points = (pts: Point[]) => pts.flatMap(([x,y]) => [x*z,y*z]);
  const verticesFor = (item: Item): Point[] => {
    if (item.tool !== 'rect') return item.points;
    const [a,b] = item.points;
    return [a,[b[0],a[1]],b,[a[0],b[1]]];
  };
  const preview = hover && pending.length ? [...pending, hover] : pending;
  function shape(tool: Item['tool'], pts: Point[], color: string, weight: number, active: boolean) {
    if (tool === 'count') return <Circle x={pts[0][0]*z} y={pts[0][1]*z}
      radius={7} stroke={color} fill="#fff" strokeWidth={weight} />;
    const p = tool === 'rect' && pts.length === 2 ? verticesFor({tool, points:pts} as Item) : pts;
    return <Line points={points(p)} closed={tool==='polygon' || tool==='rect'}
      fill={tool==='polygon' || tool==='rect' ? color + (active ? '36' : '21') : undefined}
      stroke={color} strokeWidth={weight} hitStrokeWidth={14} lineJoin="round" lineCap="round" />;
  }

  return <div className={`viewer ${mode==='pan' ? 'panning' : mode==='select' ? '' : 'drawing'}`}
    ref={scroll} data-testid="viewer"
    onPointerDown={e => {
      if (mode !== 'pan' || !scroll.current || e.button !== 0) return;
      const el = scroll.current;
      el.setPointerCapture(e.pointerId);
      drag.current={x:e.clientX,y:e.clientY,left:el.scrollLeft,top:el.scrollTop};
    }} onPointerMove={e => {
      if (!drag.current || !scroll.current) return;
      scroll.current.scrollLeft=drag.current.left+drag.current.x-e.clientX;
      scroll.current.scrollTop=drag.current.top+drag.current.y-e.clientY;
    }} onPointerUp={() => { drag.current=null; }} onPointerCancel={() => { drag.current=null; }}>
    {error && <div className="viewer-message" role="alert">{error}</div>}
    {!ready && !error && <div className="viewer-message">Rendering sheet…</div>}
    <div className="paper" style={{width,height}} data-testid="paper" data-ready={ready}>
      <canvas ref={canvas} style={{width,height}} />
      <div className="overlay">
        <Stage width={width} height={height} onPointerMove={e => {
          if (mode!=='select' && mode!=='pan') setHover(pointer(e.target.getStage()!));
        }} onPointerLeave={() => setHover(undefined)}
          onClick={e => {
            if (mode==='pan') return;
            if (mode==='select') { if (e.target===e.target.getStage()) select(); return; }
            if (!ready) return;
            const p = pointer(e.target.getStage()!);
            if (p) addPoint(p);
          }}
          onTap={e => {
            if (!ready || mode==='pan') return;
            if (mode==='select') { if (e.target===e.target.getStage()) select(); return; }
            const p = pointer(e.target.getStage()!);
            if (p) addPoint(p);
          }}>
          <Layer>
            {calibration && <Line points={points(calibration.points)} listening={false}
              stroke="#1b6575" strokeWidth={1.5} dash={[5,4]} />}
            {[...items.filter(item=>item.id!==selected), ...items.filter(item=>item.id===selected)].map(item => {
              const active = item.id===selected, color=scopes[item.scope][2];
              const [x,y] = item.points[0];
              const qty = measure(item, calibration);
              const tag = qty ? `${quantity(qty.value)} ${qty.unit}` : 'Review';
              const canEdit = active && mode==='select';
              return <Group key={item.id} opacity={item.status==='rejected' ? 0.38 : 1}
                listening={mode==='select'} draggable={canEdit}
                onClick={() => select(item.id)} onTap={() => select(item.id)}
                dragBoundFunc={pos => {
                  const xs=item.points.map(p=>p[0]*z), ys=item.points.map(p=>p[1]*z);
                  return {x:Math.max(-Math.min(...xs),Math.min(width-Math.max(...xs),pos.x)),
                    y:Math.max(-Math.min(...ys),Math.min(height-Math.max(...ys),pos.y))};
                }}
                onDragEnd={e => {
                  if (e.target!==e.currentTarget) return;
                  const p=e.target.position();
                  e.target.position({x:0,y:0});
                  changePoints(item.id,item.points.map(([a,b])=>bounded([a+p.x/z,b+p.y/z])));
                }}>
                {shape(item.tool,item.points,color,active?3:2,active)}
                <Text x={Math.max(0, x*z+8)} y={Math.max(0,y*z-16)}
                  text={tag} fill={color} fontSize={12} fontStyle="bold" padding={2} />
                {canEdit && verticesFor(item).map(([a,b], i) => <Circle key={i}
                  x={a*z} y={b*z} radius={5} fill="#fff" stroke={color} strokeWidth={2} draggable
                  onPointerDown={e => { e.cancelBubble=true; }}
                  onDragEnd={e => {
                    e.cancelBubble=true;
                    const pos=e.target.position();
                    const p=snapped([pos.x/z,pos.y/z], item.id);
                    e.target.position({x:a*z,y:b*z});
                    const pts=item.points.slice();
                    if (item.tool==='rect') {
                      const opposite=verticesFor(item)[(i+2)%4];
                      pts[0]=opposite;
                      pts[1]=p;
                    } else pts[i]=p;
                    changePoints(item.id,pts);
                  }} />)}
              </Group>;
            })}
            {preview.length > 0 && <Group listening={false}>
              <Line points={points(preview)} stroke={scopes[activeScope][2]} dash={[5,3]} strokeWidth={2}
                closed={mode==='polygon' && preview.length>2} />
              {mode==='rect' && preview.length===2 && <Rect x={Math.min(preview[0][0],preview[1][0])*z}
                y={Math.min(preview[0][1],preview[1][1])*z} width={Math.abs(preview[1][0]-preview[0][0])*z}
                height={Math.abs(preview[1][1]-preview[0][1])*z} stroke={scopes[activeScope][2]} dash={[5,3]} />}
              {pending.map(([x,y],i)=><Circle key={i} x={x*z} y={y*z} radius={4} fill="#123f49"/>)}
            </Group>}
          </Layer>
        </Stage>
      </div>
    </div>
    {pending.length>0 && <button className="cancel-trace" onClick={() => setPending([])}>Cancel trace</button>}
  </div>;
}
