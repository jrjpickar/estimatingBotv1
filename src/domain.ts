export type Point = [number, number];
export const scopes = {
  wall: ['Interior walls', 'LF', '#c53344'],
  floor: ['Flooring', 'SF', '#1b8a59'],
  ceiling: ['Ceilings', 'SF', '#8053c5'],
  slab: ['Concrete slab', 'SF', '#c25516'],
  door: ['Doors', 'EA', '#1e68c9'],
  fixture: ['Fixtures', 'EA', '#b22c82'],
  sawcut: ['Sawcutting', 'LF', '#007b84'],
  millwork: ['Millwork', 'LF', '#835d40'],
} as const;
export type Scope = keyof typeof scopes;
export type Tool = 'line' | 'polyline' | 'polygon' | 'rect' | 'count';
export type Mode = Tool | 'select' | 'pan' | 'calibrate';
export type Status = 'review' | 'approved' | 'rejected';
export interface Item {
  id: string; sheet: number; scope: Scope; tool: Tool; points: Point[];
  status: Status; source: string; thickness: number | null; edited: boolean;
}
export interface Calibration { points: [Point, Point]; feet: number; source: string }
export interface State {
  revision: number; items: Item[]; scales: Record<number, Calibration>;
  notes: Record<number, string[]>; rules: Record<number, Rule[]>; markup: number | null;
}
export interface Sheet { name: string; width: number; height: number; planName?: string }
export interface Project { id: string; name: string; sheets: Sheet[]; state: State }
export interface Rule { scope: Scope; color: string; dashed: boolean }
export const deskNames: Record<Scope,string> = {
  wall:'Demo interior stud walls', floor:'Remove flooring', ceiling:'Demo ceiling',
  slab:'Remove concrete slab', door:'Remove doors', fixture:'Remove plumbing fixtures',
  sawcut:'Sawcut concrete', millwork:'Remove millwork',
};
export interface Price {
  scopeLines: {name:string; lines:{text:string; key:string}[]}[];
  cost: number; bid: number; markup: number; warnings: string[];
  sections: {name: string; subtotal: number; lines: {
    category: string; description: string; extended: number; basis?: string; qty: number; rate: number;
  }[]}[];
}
export const distance = (a: Point, b: Point) => Math.hypot(a[0]-b[0], a[1]-b[1]);
export const factor = (scale?: Calibration) => scale && scale.feet / distance(...scale.points);
export const scopeKeys = Object.keys(scopes) as Scope[];
export const toolsFor = (scope: Scope): Tool[] => {
  const unit = scopes[scope][1];
  return unit === 'LF' ? ['line', 'polyline'] : unit === 'SF' ? ['polygon','rect'] : ['count'];
};
function area(points: Point[]) {
  const turn = (a: Point, b: Point, c: Point) =>
    (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
  const within = (a: Point, b: Point, p: Point) =>
    p.every((v, k) => Math.min(a[k], b[k]) <= v && v <= Math.max(a[k], b[k]));
  const intersects = (a: Point, b: Point, c: Point, d: Point) => {
    const p = turn(a,b,c), q = turn(a,b,d), r = turn(c,d,a), s = turn(c,d,b);
    return (p*q < 0 && r*s < 0) || (!p && within(a,b,c)) ||
      (!q && within(a,b,d)) || (!r && within(c,d,a)) || (!s && within(c,d,b));
  };
  let total = 0;
  for (let i=0; i<points.length; i++) {
    const a = points[i], b = points[(i+1)%points.length];
    const prev = points[(i+points.length-1)%points.length];
    if (!distance(a,b) || (!turn(prev,a,b) && (within(a,b,prev) || within(prev,a,b)))) return 0;
    total += a[0]*b[1] - b[0]*a[1];
    for (let j=i+2; j<points.length; j++) {
      if (i === 0 && j === points.length-1) continue;
      if (intersects(a,b,points[j],points[(j+1)%points.length])) return 0;
    }
  }
  return Math.abs(total)/2;
}
export function measure(item: Item, scale?: Calibration) {
  const unit = scopes[item.scope][1], p = item.points, f = factor(scale);
  if (!toolsFor(item.scope).includes(item.tool)) return null;
  if (unit === 'EA') return p.length === 1 ? { value: 1, unit } : null;
  if (!f || !Number.isFinite(f)) return null;
  if (unit === 'LF') {
    if (p.length < 2) return null;
    const value = p.slice(1).reduce((sum, point, i) => sum + distance(point, p[i]), 0)*f;
    return value && Number.isFinite(value) ? { value, unit } : null;
  }
  if (p.length < 2) return null;
  const value = (item.tool === 'rect' ? Math.abs((p[0][0]-p[1][0])*(p[0][1]-p[1][1])) : area(p))*f*f;
  return value && Number.isFinite(value) ? { value, unit,
    cy: item.scope === 'slab' && item.thickness ? value*item.thickness/324 : undefined } : null;
}
export const quantity = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
export const currency = (n: number) => n.toLocaleString('en-US', {style:'currency',currency:'USD'});
export async function request(url: string, init?: RequestInit) {
  const response = import.meta.env.MODE === 'netlify'
    ? await (await import('./hosted')).hostedRequest(url, init)
    : await fetch(url, init);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status}).`);
  }
  return response;
}
export const json = (value: unknown, method = 'POST'): RequestInit => ({
  method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(value),
});
