/**
 * Web Mercator maths for the tile map (field mode phase 2, 0412). No dependency: the map draws square 256 px tiles from a same-origin URL template and
 * puts the sites on top as pins. Everything here is pure so it can be tested without a browser.
 */
export const TILE = 256;
export const MAX_LAT = 85.0511287798;

export interface View { lat: number; lon: number; zoom: number }
export interface Size { width: number; height: number }
export interface TileRef { z: number; x: number; y: number; left: number; top: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** World pixel of a place at a zoom level (the whole world is TILE * 2^zoom pixels wide). */
export function project(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const scale = TILE * 2 ** zoom;
  const la = clamp(lat, -MAX_LAT, MAX_LAT);
  const s = Math.sin((la * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
}

/** The place under a world pixel. */
export function unproject(x: number, y: number, zoom: number): { lat: number; lon: number } {
  const scale = TILE * 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon };
}

/** Screen position (px from the top-left of the map box) of a place for the current view. */
export function toScreen(lat: number, lon: number, view: View, size: Size): { x: number; y: number } {
  const c = project(view.lat, view.lon, view.zoom), p = project(lat, lon, view.zoom);
  return { x: p.x - c.x + size.width / 2, y: p.y - c.y + size.height / 2 };
}

/** The view after dragging the map by (dx, dy) screen pixels. */
export function pan(view: View, dx: number, dy: number): View {
  const c = project(view.lat, view.lon, view.zoom);
  const n = unproject(c.x - dx, c.y - dy, view.zoom);
  return { ...view, lat: clamp(n.lat, -MAX_LAT, MAX_LAT), lon: clamp(n.lon, -180, 180) };
}

/** The view after changing the zoom by `delta` levels inside [min, max], keeping the place under (px, py) fixed (the pointer for a wheel zoom). */
export function zoomAt(view: View, delta: number, min: number, max: number, size: Size, px = size.width / 2, py = size.height / 2): View {
  const zoom = clamp(Math.round(view.zoom + delta), min, max);
  if (zoom === view.zoom) return view;
  const under = unproject(project(view.lat, view.lon, view.zoom).x + (px - size.width / 2), project(view.lat, view.lon, view.zoom).y + (py - size.height / 2), view.zoom);
  const u = project(under.lat, under.lon, zoom);
  const n = unproject(u.x - (px - size.width / 2), u.y - (py - size.height / 2), zoom);
  return { zoom, lat: clamp(n.lat, -MAX_LAT, MAX_LAT), lon: clamp(n.lon, -180, 180) };
}

/** The tiles that cover the box, each with the pixel position of its top-left corner. Tile x wraps around the world; y outside the world is skipped. */
export function visibleTiles(view: View, size: Size): TileRef[] {
  const z = Math.round(view.zoom), n = 2 ** z;
  const c = project(view.lat, view.lon, z);
  const left = c.x - size.width / 2, top = c.y - size.height / 2;
  const x0 = Math.floor(left / TILE), x1 = Math.floor((left + size.width) / TILE);
  const y0 = Math.floor(top / TILE), y1 = Math.floor((top + size.height) / TILE);
  const out: TileRef[] = [];
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= n) continue;
    for (let x = x0; x <= x1; x++) out.push({ z, x: ((x % n) + n) % n, y, left: x * TILE - left, top: y * TILE - top });
  }
  return out;
}

/** The address of a tile from the admin's template. Only a path on this server is ever built (the setting is validated the same way by the database). */
export function tileUrl(template: string, t: Pick<TileRef, 'z' | 'x' | 'y'>): string {
  return template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
}

/** The same rule as the database: empty, or a path on this server with {z}, {x} and {y}; no other host, no "//", no "..". */
export function isSafeTileTemplate(v: string): boolean {
  if (v === '') return true;
  return /^\/[A-Za-z0-9._~/{}-]{1,198}$/.test(v) && !v.includes('//') && !v.includes('..') && v.includes('{z}') && v.includes('{x}') && v.includes('{y}');
}

/** The view that fits every pin (a few pixels of margin), inside [min, max] zoom. One pin or none: the start view. */
export function fitView(points: { lat: number; lon: number }[], size: Size, start: View, min: number, max: number): View {
  if (points.length < 2 || size.width < 50 || size.height < 50) return points.length === 1 ? { lat: points[0]!.lat, lon: points[0]!.lon, zoom: clamp(Math.max(start.zoom, 12), min, max) } : start;
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2, lon = (Math.min(...lons) + Math.max(...lons)) / 2;
  for (let z = max; z >= min; z--) {
    const a = project(Math.max(...lats), Math.min(...lons), z), b = project(Math.min(...lats), Math.max(...lons), z);
    if (b.x - a.x <= size.width - 60 && b.y - a.y <= size.height - 60) return { lat, lon, zoom: z };
  }
  return { lat, lon, zoom: min };
}
