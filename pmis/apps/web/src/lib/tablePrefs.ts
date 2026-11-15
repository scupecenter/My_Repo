import { loadPref, savePref } from './localPref';

/** A column of a list screen. `forbidden` = hidden by permission: never shown, never offered, never stored as visible (plan G1/G11). */
export type ColDef = { id: string; w: number; min?: number; max?: number; pinned?: boolean; forbidden?: boolean; off?: boolean };
export type Density = 'comfortable' | 'compact';
export type Prefs = { order: string[]; hidden: string[]; width: Record<string, number>; density: Density };

export const EMPTY_PREFS: Prefs = { order: [], hidden: [], width: {}, density: 'comfortable' };
export const prefsKey = (screen: string, user: string) => `pmis.table.${screen}.${user}`;

/** Merge stored prefs with the current column list: unknown ids are dropped, new ones appended, forbidden ones removed. */
export function reconcile(p: Prefs, defs: ColDef[]): Prefs {
  const ok = new Set(defs.filter((d) => !d.forbidden).map((d) => d.id));
  const order = [...p.order.filter((id) => ok.has(id)), ...defs.filter((d) => ok.has(d.id) && !p.order.includes(d.id)).map((d) => d.id)];
  return { order, hidden: p.hidden.filter((id) => ok.has(id)), width: Object.fromEntries(Object.entries(p.width).filter(([id]) => ok.has(id))), density: p.density === 'compact' ? 'compact' : 'comfortable' };
}

/** Visible columns in order; pinned (identity) columns always come first and cannot be hidden. */
export function visibleCols(p: Prefs, defs: ColDef[], auto: Record<string, number> = {}): (ColDef & { px: number })[] {
  const by = new Map(defs.map((d) => [d.id, d]));
  const all = p.order.map((id) => by.get(id)).filter((d): d is ColDef => !!d && !d.forbidden && (d.pinned || !p.hidden.includes(d.id)));
  return [...all.filter((d) => d.pinned), ...all.filter((d) => !d.pinned)].map((d) => ({ ...d, px: p.width[d.id] ?? auto[d.id] ?? d.w }));
}

export function moveCol(p: Prefs, defs: ColDef[], id: string, delta: -1 | 1): Prefs {
  const free = p.order.filter((x) => !defs.find((d) => d.id === x)?.pinned);
  const i = free.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= free.length) return p;
  [free[i], free[j]] = [free[j], free[i]];
  return { ...p, order: [...p.order.filter((x) => defs.find((d) => d.id === x)?.pinned), ...free] };
}
export function dropCol(p: Prefs, defs: ColDef[], id: string, onto: string): Prefs {
  const pinned = (x: string) => !!defs.find((d) => d.id === x)?.pinned;
  if (id === onto || pinned(id) || pinned(onto)) return p;
  const rest = p.order.filter((x) => x !== id);
  rest.splice(rest.indexOf(onto), 0, id);
  return { ...p, order: rest };
}
export const toggleCol = (p: Prefs, defs: ColDef[], id: string): Prefs =>
  defs.find((d) => d.id === id)?.pinned ? p : { ...p, hidden: p.hidden.includes(id) ? p.hidden.filter((x) => x !== id) : [...p.hidden, id] };
export const resizeCol = (p: Prefs, defs: ColDef[], id: string, px: number): Prefs => {
  const d = defs.find((x) => x.id === id);
  return d ? { ...p, width: { ...p.width, [id]: Math.round(Math.min(640, Math.max(d.min ?? 60, px))) } } : p;
};

export const AUTO_PAD = 20;      // cell padding (px-2 on both sides = 16) plus a little air
export const AUTO_HEAD_PAD = 14; // room for the resize handle next to the header label
export const AUTO_MAX = 360;     // default upper bound of an auto-sized column
export const AUTO_SAMPLE = 120;  // rows measured per column

/** Auto width of one column: the widest of the header and the sampled cells (a sample may carry extra pixels, e.g. the padding of a chip), plus padding, kept inside [min, max]. `measure` returns the pixel width of a text. */
export type FitSample = string | [text: string, extraPx: number];
export function fitWidth(def: ColDef, header: string, samples: FitSample[], measure: (text: string) => number): number {
  const head = measure(header) + AUTO_PAD + AUTO_HEAD_PAD;
  let body = 0;
  for (const s of samples.slice(0, AUTO_SAMPLE)) body = Math.max(body, Array.isArray(s) ? measure(s[0]) + s[1] + AUTO_PAD : measure(s) + AUTO_PAD);
  const lo = def.min ?? 60, hi = Math.max(lo, def.max ?? AUTO_MAX);
  return Math.round(Math.min(hi, Math.max(lo, head, body)));
}

/** Sticky offset (px from the inline start) of every pinned column, in order: the select box first, then the pinned columns one after the other. */
export function pinOffsets(cols: { id: string; px: number; pinned?: boolean }[], selW: number): Record<string, number> {
  const out: Record<string, number> = {};
  let x = selW;
  for (const c of cols) if (c.pinned) { out[c.id] = x; x += c.px; }
  return out;
}

/** Columns that start hidden (`off`) until the user turns them on. */
export const defaultHidden = (defs: ColDef[]) => defs.filter((d) => d.off).map((d) => d.id);

export const loadPrefs = (screen: string, user: string, defs: ColDef[]): Prefs => {
  const raw = loadPref<Partial<Prefs>>(prefsKey(screen, user), {});
  return reconcile({ ...EMPTY_PREFS, ...raw, width: raw.width ?? {}, hidden: raw.hidden ?? defaultHidden(defs), order: raw.order ?? [] }, defs);
};
export const storePrefs = (screen: string, user: string, p: Prefs) => savePref(prefsKey(screen, user), p);
