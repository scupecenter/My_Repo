import { loadPref, savePref } from './localPref';

/** A column of a list screen. `forbidden` = hidden by permission: never shown, never offered, never stored as visible (plan G1/G11). */
export type ColDef = { id: string; w: number; min?: number; pinned?: boolean; forbidden?: boolean; off?: boolean };
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
export function visibleCols(p: Prefs, defs: ColDef[]): (ColDef & { px: number })[] {
  const by = new Map(defs.map((d) => [d.id, d]));
  const all = p.order.map((id) => by.get(id)).filter((d): d is ColDef => !!d && !d.forbidden && (d.pinned || !p.hidden.includes(d.id)));
  return [...all.filter((d) => d.pinned), ...all.filter((d) => !d.pinned)].map((d) => ({ ...d, px: p.width[d.id] ?? d.w }));
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

/** Columns that start hidden (`off`) until the user turns them on. */
export const defaultHidden = (defs: ColDef[]) => defs.filter((d) => d.off).map((d) => d.id);

export const loadPrefs = (screen: string, user: string, defs: ColDef[]): Prefs => {
  const raw = loadPref<Partial<Prefs>>(prefsKey(screen, user), {});
  return reconcile({ ...EMPTY_PREFS, ...raw, width: raw.width ?? {}, hidden: raw.hidden ?? defaultHidden(defs), order: raw.order ?? [] }, defs);
};
export const storePrefs = (screen: string, user: string, p: Prefs) => savePref(prefsKey(screen, user), p);
