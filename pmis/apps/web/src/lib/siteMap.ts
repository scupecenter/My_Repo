import type { components } from '@/api/schema';
import { CITIES } from './libya';

/**
 * The logic of the site map (OV-12, SC-10; owner request 2026-11-05, technical decision "site map"): what light a site shows, its colour, the filters
 * (kept in the URL) and the ECharts option. Pure functions, so the rules are tested without a browser.
 */
export type SiteMapItem = components['schemas']['SiteMapItem'];
export type SiteMapData = components['schemas']['SiteMap'];
export type SiteMapGroup = components['schemas']['SiteMapGroup'];

/** in progress in a stream or milestone (pulsing) · On-Air reached (steady green) · On Hold (steady amber) · not started (grey) · cancelled (dark grey, hidden by default) */
export type Light = 'progress' | 'on_air' | 'hold' | 'idle' | 'cancelled';
export type ColourBy = 'stream' | 'milestone';

export function lightOf(s: Pick<SiteMapItem, 'overall_status' | 'on_air_reached' | 'milestone_code'>): Light {
  if (s.overall_status === 'cancelled') return 'cancelled';
  // Once the On-Air milestone is reached the light is steady green, also when the site is later put on hold (decision 2026-11-05)
  if (s.on_air_reached || s.overall_status === 'completed') return 'on_air';
  if (s.overall_status === 'on_hold') return 'hold';
  if (s.overall_status === 'not_started' || !s.milestone_code) return 'idle';
  return 'progress';
}

/** The legend category of a site: its stream or milestone while in progress, otherwise its light. */
export function categoryOf(s: SiteMapItem, by: ColourBy): string {
  const l = lightOf(s);
  if (l !== 'progress') return l;
  return by === 'stream' ? `stream:${s.stream_code ?? ''}` : `ms:${s.milestone_code ?? ''}`;
}

const STREAM_TOKEN: Record<string, string> = { DESIGN_ACQ: 'stream-design', CW: 'stream-cw', TE: 'stream-te', CLOSURE: 'stream-closure' };
const FALLBACK: Record<string, string> = {
  'stream-design': '#6d28d9', 'stream-cw': '#c2410c', 'stream-te': '#1d4ed8', 'stream-closure': '#0f766e', 'map-idle': '#8a8a8a', 'map-hold': '#b45309', 'map-cancel': '#3f3f3f',
  done: '#16a34a', late: '#dc2626', 'map-tower': '#555555', 'map-land': '#f2f2f2', 'map-sea': '#ffffff', 'map-line': '#c9c9c9', mute: '#6b7280', ink: '#1f2937',
  'ms-1': '#6d28d9', 'ms-2': '#c2410c', 'ms-3': '#9a3412', 'ms-4': '#7c2d12', 'ms-5': '#2563eb', 'ms-6': '#1e3a8a', 'ms-7': '#0f766e', 'ms-8': '#134e4a', 'ms-9': '#4c1d95', 'ms-10': '#2e1065',
};

/** A design token of the active theme (tokens.css), with a fallback when the style sheet is not loaded (tests). */
export function token(name: string): string {
  const v = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return v || FALLBACK[name] || '#888888';
}

/** The token of a category: streams by their code (an unknown stream takes a milestone colour by its order), milestones by their workflow order. */
export function categoryToken(cat: string, streams: SiteMapGroup[], milestones: SiteMapGroup[]): string {
  if (cat === 'on_air') return 'done';
  if (cat === 'hold') return 'map-hold';
  if (cat === 'idle') return 'map-idle';
  if (cat === 'cancelled') return 'map-cancel';
  const [kind, code = ''] = cat.split(':');
  if (kind === 'stream') return STREAM_TOKEN[code] ?? `ms-${(Math.max(0, streams.findIndex((s) => s.code === code)) % 10) + 1}`;
  return `ms-${(Math.max(0, milestones.findIndex((m) => m.code === code)) % 10) + 1}`;
}

/** The categories of the legend, in order: the streams (or milestones), then On-Air, On Hold, not started and, when shown, cancelled. */
export function categories(by: ColourBy, d: Pick<SiteMapData, 'streams' | 'milestones'>, withCancelled: boolean): string[] {
  const groups = by === 'stream' ? d.streams.map((s) => `stream:${s.code}`) : d.milestones.map((m) => `ms:${m.code}`);
  return [...groups, 'on_air', 'hold', 'idle', ...(withCancelled ? ['cancelled'] : [])];
}

// ------------------------------------------------------------------ filters (in the URL, prefix map_)
export const LIST_KEYS = ['status', 'region', 'sub', 'owner', 'scenario', 'stream', 'ms', 'cluster'] as const;
export type ListKey = (typeof LIST_KEYS)[number];
export interface MapFilters {
  status: string[]; region: string[]; sub: string[]; owner: string[]; scenario: string[]; stream: string[]; ms: string[]; cluster: string[];
  late: boolean; q: string; by: ColourBy; hide: string[];
}
/** The value of a site for each list filter ('' = none). */
export const valueOf: Record<ListKey, (s: SiteMapItem) => string> = {
  status: (s) => s.overall_status,
  region: (s) => String(s.region_id),
  sub: (s) => s.sub_region ?? '',
  owner: (s) => s.tower_owner ?? '',
  scenario: (s) => s.delivery_scenario ?? '',
  stream: (s) => s.stream_code ?? '',
  ms: (s) => s.milestone_code ?? '',
  cluster: (s) => s.cluster_code ?? '',
};

const P = 'map_';
const list = (sp: URLSearchParams, k: string): string[] => (sp.get(P + k) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
export function readFilters(sp: URLSearchParams): MapFilters {
  return {
    status: list(sp, 'status'), region: list(sp, 'region'), sub: list(sp, 'sub'), owner: list(sp, 'owner'), scenario: list(sp, 'scenario'), stream: list(sp, 'stream'),
    ms: list(sp, 'ms'), cluster: list(sp, 'cluster'), late: sp.get(`${P}late`) === '1', q: sp.get(`${P}q`) ?? '', by: sp.get(`${P}by`) === 'milestone' ? 'milestone' : 'stream',
    hide: list(sp, 'hide'),
  };
}
/** The URL parameters of a change of the filters (empty values are removed). */
export function filterParams(f: Partial<MapFilters>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of LIST_KEYS) if (f[k] !== undefined) out[P + k] = f[k]!.join(',');
  if (f.late !== undefined) out[`${P}late`] = f.late ? '1' : '';
  if (f.q !== undefined) out[`${P}q`] = f.q;
  if (f.by !== undefined) out[`${P}by`] = f.by === 'milestone' ? 'milestone' : '';
  if (f.hide !== undefined) out[`${P}hide`] = f.hide.join(',');
  return out;
}
export const activeCount = (f: MapFilters): number => LIST_KEYS.filter((k) => f[k].length > 0).length + (f.late ? 1 : 0) + (f.q.trim() ? 1 : 0);

/** The dashboard's own filters (region, cluster, scenario, stream) narrow the map too: they are the outer scope. */
export interface OuterScope { region_id?: string; cluster_code?: string; scenario?: string; stream?: string }

/** The sites that pass the filters, leaving out one list filter (`except`) for the counts of its own options. Cancelled sites only when the status filter asks. */
export function applyFilters(items: SiteMapItem[], f: MapFilters, outer: OuterScope = {}, except?: ListKey): SiteMapItem[] {
  const q = f.q.trim().toLowerCase();
  return items.filter((s) => {
    if (outer.region_id && String(s.region_id) !== outer.region_id) return false;
    if (outer.cluster_code && s.cluster_code !== outer.cluster_code) return false;
    if (outer.scenario && s.delivery_scenario !== outer.scenario) return false;
    if (outer.stream && s.stream_code !== outer.stream) return false;
    if (s.overall_status === 'cancelled' && !f.status.includes('cancelled')) return false;
    for (const k of LIST_KEYS) if (k !== except && f[k].length > 0 && !f[k].includes(valueOf[k](s))) return false;
    if (f.late && !s.late) return false;
    if (q && !(s.site_code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || (s.name_ar ?? '').toLowerCase().includes(q))) return false;
    return true;
  });
}

/** Counts per option of a list filter, over the sites the other filters keep (faceted counts). Cancelled ones count for the status options. */
export function facet(items: SiteMapItem[], f: MapFilters, outer: OuterScope, key: ListKey): Map<string, number> {
  const base = key === 'status' ? applyFilters(items, { ...f, status: [...f.status, 'cancelled'] }, outer, 'status') : applyFilters(items, f, outer, key);
  const m = new Map<string, number>();
  for (const s of base) { const v = valueOf[key](s); m.set(v, (m.get(v) ?? 0) + 1); }
  return m;
}

// ------------------------------------------------------------------ the chart
/** A lattice tower on a 10 x 14 box: two legs, a top and two cross braces. The light dot sits on its top (the site's coordinate). */
export const TOWER_PATH = 'path://M4.2 0 L5.8 0 L10 14 L8.4 14 L5 2.8 L1.6 14 L0 14 Z M2.6 8.6 L7.4 8.6 L7.8 10 L2.2 10 Z M3.6 5 L6.4 5 L6.7 6.1 L3.3 6.1 Z';

export interface MapContext {
  by: ColourBy;
  streams: SiteMapGroup[];
  milestones: SiteMapGroup[];
  reducedMotion: boolean;
  rtl: boolean;
  /** the tooltip text of a site (already in the UI language) */
  tip: (s: SiteMapItem) => string;
  cityName: (key: string) => string;
  /** colours by token name (the active theme) */
  colour?: (tokenName: string) => string;
}

export interface MapMark { site: SiteMapItem; light: Light; category: string; colour: string; pulse: boolean }

/** How each drawn site looks: only sites with valid coordinates. Pulses only while in progress and when motion is allowed. */
export function marks(items: SiteMapItem[], ctx: Pick<MapContext, 'by' | 'streams' | 'milestones' | 'reducedMotion' | 'colour'>): MapMark[] {
  const col = ctx.colour ?? token;
  return items.filter((s) => s.has_coordinates).map((s) => {
    const light = lightOf(s);
    const category = categoryOf(s, ctx.by);
    return { site: s, light, category, colour: col(categoryToken(category, ctx.streams, ctx.milestones)), pulse: light === 'progress' && !ctx.reducedMotion };
  });
}

const esc = (x: string): string => x.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The ECharts option of the map: the bundled outline of Libya (geo, pan and zoom), city labels, one tower per site and its light. In progress = an
 * effect-scatter ripple (or, with reduced motion, a steady halo); On-Air, On Hold, not started and cancelled = a steady dot. A late site (late tasks or
 * behind its baseline) has a red ring and a slightly larger light. No tile layer: nothing is fetched.
 */
export function buildMapOption(ms: MapMark[], ctx: MapContext): Record<string, unknown> {
  const col = ctx.colour ?? token;
  const late = col('late'), sea = col('map-sea'), mute = col('mute');
  const point = (m: MapMark, size = 7) => ({
    value: [m.site.longitude, m.site.latitude], name: m.site.site_code, site: m.site.id, tip: ctx.tip(m.site),
    symbolSize: m.site.late ? size + 3 : size,
    itemStyle: { color: m.colour, borderColor: m.site.late ? late : sea, borderWidth: m.site.late ? 2 : 1 },
  });
  const steady = ms.filter((m) => !m.pulse);
  const pulsing = ms.filter((m) => m.pulse);
  const halo = ctx.reducedMotion ? ms.filter((m) => m.light === 'progress') : [];
  const series: Record<string, unknown>[] = [
    {
      id: 'cities', type: 'scatter', coordinateSystem: 'geo', silent: true, z: 1, symbolSize: 4, itemStyle: { color: mute },
      label: { show: true, position: ctx.rtl ? 'left' : 'right', color: mute, fontSize: 11, formatter: '{b}' },
      data: CITIES.map((c) => ({ name: ctx.cityName(c.key), value: [c.lon, c.lat] })),
    },
    {
      id: 'towers', type: 'scatter', coordinateSystem: 'geo', z: 2, symbol: TOWER_PATH, symbolSize: [9, 13], symbolOffset: [0, '50%'], itemStyle: { color: col('map-tower') },
      data: ms.map((m) => ({ value: [m.site.longitude, m.site.latitude], name: m.site.site_code, site: m.site.id, tip: ctx.tip(m.site) })),
    },
    ...(halo.length ? [{ id: 'halo', type: 'scatter', coordinateSystem: 'geo', silent: true, z: 3, data: halo.map((m) => ({ ...point(m, 16), itemStyle: { color: m.colour, opacity: 0.28 } })) }] : []),
    { id: 'lights', type: 'scatter', coordinateSystem: 'geo', z: 4, data: steady.map((m) => point(m)) },
    ...(pulsing.length ? [{
      id: 'pulse', type: 'effectScatter', coordinateSystem: 'geo', z: 4, showEffectOn: 'render', rippleEffect: { brushType: 'fill', scale: 3.2, period: 2.8, number: 2 },
      data: pulsing.map((m) => point(m)),
    }] : []),
  ];
  return {
    animation: !ctx.reducedMotion,
    textStyle: { fontFamily: 'Cairo, system-ui, sans-serif' },
    tooltip: { trigger: 'item', formatter: (p: { data?: { tip?: string } }) => (p.data?.tip ? esc(p.data.tip).replace(/\n/g, '<br/>') : '') },
    geo: {
      map: 'libya', roam: true, scaleLimit: { min: 1, max: 16 }, aspectScale: 0.9, silent: true, layoutCenter: ['50%', '50%'], layoutSize: '95%',
      itemStyle: { areaColor: col('map-land'), borderColor: col('map-line'), borderWidth: 1 }, emphasis: { disabled: true }, label: { show: false },
    },
    series,
  };
}
