import { NAV, type NavItem } from '@/components/navItems';
import { PEOPLE_KEYS } from '@/components/PeopleAdmin';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { ICONS, type Concept } from './icons';

/**
 * The shared layout of the side menu (owner request 2026-11-09, contract 0.15.1, migration 0081). Main headings hold screen keys and sub-headings; a
 * sub-heading holds screen keys only. The layout only orders the screens of the code (NAV): labels, icons, routes and rights stay in the code, and the
 * permission filter applies after the layout.
 */
export interface NavSub { id: string; name_en: string; name_ar: string; icon: string | null; children: string[] }
export interface NavHead { id: string; name_en: string; name_ar: string; icon: string | null; children: (string | NavSub)[] }
export interface Layout { headings: NavHead[] }

/** The default headings, in order (the groups of navItems.ts). */
export const DEFAULT_GROUPS = ['work', 'site_register', 'registers', 'data', 'admin', 'logs'] as const;
export const OTHER_ID = 'other';
export const NAME_MAX = 60;
export const MAX_MAIN = 30;
export const MAX_HEADINGS = 100;

/** The screens of the side menu: the NAV entries, without the tabs of the Users & Roles screen (one entry, admin.users, opens it). */
export const NAV_SIDE: readonly NavItem[] = NAV.filter((n) => n.key === 'admin.users' || !PEOPLE_KEYS.has(n.key));

const groupName = (g: string, dict: { nav: Record<string, string> }) => dict.nav[`group_${g}`] ?? g;

/** The layout of the code: the six groups with their screens in NAV order. */
export function defaultLayout(nav: readonly NavItem[] = NAV_SIDE): Layout {
  return {
    headings: DEFAULT_GROUPS.map((g) => ({
      id: g, name_en: groupName(g, en), name_ar: groupName(g, ar), icon: null,
      children: nav.filter((n) => n.group === g).map((n) => n.key),
    })),
  };
}

const isSub = (c: string | NavSub): c is NavSub => typeof c === 'object' && c !== null;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const iconOrNull = (v: unknown): string | null => (typeof v === 'string' && v in ICONS ? v : null);

/**
 * Merges a saved layout with the screens the code knows: a key of a screen that no longer exists (or a duplicate) is dropped; a screen missing from the layout is
 * appended at the end of its default heading (or of "Other" when that heading was deleted). With no saved layout, the default of the code.
 */
export function resolveLayout(saved: unknown, nav: readonly NavItem[] = NAV_SIDE): Layout {
  const heads = (saved as { headings?: unknown } | null)?.headings;
  if (!Array.isArray(heads) || !heads.length) return defaultLayout(nav);
  const known = new Set(nav.map((n) => n.key));
  const used = new Set<string>();
  const ids = new Set<string>();
  const take = (k: unknown): k is string => typeof k === 'string' && known.has(k) && !used.has(k) && (used.add(k), true);
  const head = (h: Record<string, unknown>) => {
    const id = str(h.id);
    if (!id || ids.has(id)) return null;
    ids.add(id);
    return { id, name_en: str(h.name_en) || id, name_ar: str(h.name_ar) || str(h.name_en) || id, icon: iconOrNull(h.icon) };
  };
  const out: NavHead[] = [];
  for (const raw of heads) {
    if (!raw || typeof raw !== 'object') continue;
    const h = head(raw as Record<string, unknown>);
    if (!h) continue;
    const children: (string | NavSub)[] = [];
    for (const c of Array.isArray((raw as NavHead).children) ? (raw as NavHead).children : []) {
      if (take(c)) children.push(c);
      else if (c && typeof c === 'object') {
        const s = head(c as unknown as Record<string, unknown>);
        if (s) children.push({ ...s, children: (Array.isArray(c.children) ? c.children : []).filter(take) });
      }
    }
    out.push({ ...h, children });
  }
  if (!out.length) return defaultLayout(nav);
  for (const n of nav) {
    if (used.has(n.key)) continue;
    const target = findHeading({ headings: out }, n.group) ?? findHeading({ headings: out }, OTHER_ID) ?? (out.push(otherHeading()), out[out.length - 1]!);
    target.children.push(n.key);
  }
  return { headings: out };
}

export const otherHeading = (): NavHead => ({ id: OTHER_ID, name_en: en.navEdit.other, name_ar: ar.navEdit.other, icon: null, children: [] });

/** A main or a sub-heading by id. */
export function findHeading(l: Layout, id: string): NavHead | NavSub | undefined {
  for (const h of l.headings) {
    if (h.id === id) return h;
    for (const c of h.children) if (isSub(c) && c.id === id) return c;
  }
  return undefined;
}

/** All heading ids (main and sub). */
export const headingIds = (l: Layout) => l.headings.flatMap((h) => [h.id, ...h.children.filter(isSub).map((s) => s.id)]);
export const headingCount = (l: Layout) => headingIds(l).length;
/** Every screen key of a heading, sub-headings included. */
export const keysOf = (h: NavHead | NavSub): string[] => h.children.flatMap((c) => (isSub(c) ? c.children : [c]));
export const sameLayout = (a: Layout | null, b: Layout | null) => JSON.stringify(a) === JSON.stringify(b);
export const headingName = (h: { name_en: string; name_ar: string }, lang: string) => (lang === 'ar' ? h.name_ar : h.name_en);
export const headingIcon = (h: { icon: string | null }): Concept | null => (h.icon && h.icon in ICONS ? (h.icon as Concept) : null);
export { isSub };

// ---------------------------------------------------------------------------------------------------------------- editing (pure functions)
/** A node of the tree: `i:<screen key>` or `h:<heading id>`. */
export type Ref = string;
export const itemRef = (k: string): Ref => `i:${k}`;
export const headRef = (id: string): Ref => `h:${id}`;

type Loc =
  | { kind: 'main'; main: number }
  | { kind: 'child'; main: number; index: number; sub: boolean }
  | { kind: 'sub'; main: number; parent: number; index: number };

const clone = (l: Layout): Layout => JSON.parse(JSON.stringify(l)) as Layout;
const refOf = (c: string | NavSub): Ref => (isSub(c) ? headRef(c.id) : itemRef(c));

export function locate(l: Layout, ref: Ref): Loc | null {
  for (let m = 0; m < l.headings.length; m++) {
    const h = l.headings[m]!;
    if (headRef(h.id) === ref) return { kind: 'main', main: m };
    for (let i = 0; i < h.children.length; i++) {
      const c = h.children[i]!;
      if (refOf(c) === ref) return { kind: 'child', main: m, index: i, sub: isSub(c) };
      if (isSub(c)) {
        const j = c.children.findIndex((k) => itemRef(k) === ref);
        if (j >= 0) return { kind: 'sub', main: m, parent: i, index: j };
      }
    }
  }
  return null;
}

function arrayMove<T>(a: T[], from: number, to: number) { const [x] = a.splice(from, 1); a.splice(to, 0, x!); }

/**
 * The keyboard move (Space picks, arrows move, Space drops): one step up (-1) or down (+1) in reading order. An item steps into a sub-heading it meets, out of
 * a sub-heading at its ends, and into the next or previous main heading at the ends of its own; a sub-heading moves among the entries of its main heading and
 * to the next or previous main heading; a main heading moves among the main headings. Null when it cannot move further.
 */
export function keyMove(src: Layout, ref: Ref, dir: -1 | 1): Layout | null {
  const l = clone(src);
  const loc = locate(l, ref);
  if (!loc) return null;
  const H = l.headings;
  if (loc.kind === 'main') {
    const j = loc.main + dir;
    if (j < 0 || j >= H.length) return null;
    arrayMove(H, loc.main, j);
    return l;
  }
  if (loc.kind === 'sub') {
    const sub = H[loc.main]!.children[loc.parent] as NavSub;
    const j = loc.index + dir;
    if (j >= 0 && j < sub.children.length) { arrayMove(sub.children, loc.index, j); return l; }
    const [k] = sub.children.splice(loc.index, 1);
    H[loc.main]!.children.splice(loc.parent + (dir > 0 ? 1 : 0), 0, k!);
    return l;
  }
  const kids = H[loc.main]!.children;
  const j = loc.index + dir;
  if (j >= 0 && j < kids.length) {
    const next = kids[j]!;
    if (!loc.sub && isSub(next)) {
      const [k] = kids.splice(loc.index, 1) as string[];
      if (dir > 0) next.children.unshift(k!); else next.children.push(k!);
      return l;
    }
    arrayMove(kids, loc.index, j);
    return l;
  }
  const m = loc.main + dir;
  if (m < 0 || m >= H.length) return null;
  const [node] = kids.splice(loc.index, 1);
  if (dir > 0) H[m]!.children.unshift(node!); else H[m]!.children.push(node!);
  return l;
}

/**
 * The pointer drop: `active` dropped on `over` (a node, or `end:<heading id>` for the end of a heading). In the same list it takes the place of `over`
 * (as a sortable list does); in another list it goes before `over`; on a heading or its end it goes to the end of that heading. Null when not allowed.
 */
export function dropOn(src: Layout, active: Ref, over: Ref): Layout | null {
  if (active === over) return null;
  const l = clone(src);
  const a = locate(l, active);
  if (!a) return null;
  const H = l.headings;
  const end = over.startsWith('end:') ? over.slice(4) : null;
  const o = end === null ? locate(l, over) : locate(l, headRef(end));
  if (!o) return null;
  if (a.kind === 'main') {
    const to = o.main;
    if (to === a.main) return null;
    arrayMove(H, a.main, to);
    return l;
  }
  if (a.kind === 'child' && a.sub) {
    // a sub-heading goes into a main heading, never into itself or another sub-heading
    const sub = H[a.main]!.children[a.index] as NavSub;
    const main = o.main;
    let index: number;
    if (o.kind === 'main') index = main === a.main ? H[main]!.children.length - 1 : H[main]!.children.length;
    else if (o.kind === 'child') { if (o.main === a.main && o.index === a.index) return null; index = o.index; }
    else { if (o.main === a.main && o.parent === a.index) return null; index = o.parent; } // inside itself: no move
    if (main === a.main) { if (index === a.index) return null; arrayMove(H[main]!.children, a.index, index); return l; }
    H[a.main]!.children.splice(a.index, 1);
    H[main]!.children.splice(index, 0, sub);
    return l;
  }
  // an item
  const key = active.slice(2);
  const list = (loc: Loc): string[] | (string | NavSub)[] => (loc.kind === 'sub' ? (H[loc.main]!.children[loc.parent] as NavSub).children : H[loc.main]!.children);
  const from = list(a);
  const fromIndex = a.index;
  let target: (string | NavSub)[]; let index: number; let atEnd = true;
  if (o.kind === 'main') { target = H[o.main]!.children; index = target.length; }
  else if (o.kind === 'child' && o.sub) { target = (H[o.main]!.children[o.index] as NavSub).children; index = target.length; } // on a sub-heading or its end
  else { target = list(o); index = o.index; atEnd = false; }
  if (target === from) {
    if (atEnd) index = target.length - 1;
    if (index === fromIndex) return null;
    arrayMove(target, fromIndex, index);
    return l;
  }
  from.splice(fromIndex, 1);
  target.splice(index, 0, key);
  return l;
}

/** A new heading id that is not used yet. */
export function newHeadingId(l: Layout): string {
  const used = new Set(headingIds(l));
  let n = l.headings.length + 1;
  while (used.has(`h${n}`)) n++;
  return `h${n}`;
}

export function addMain(src: Layout, h: Omit<NavHead, 'children' | 'id'>): Layout {
  const l = clone(src);
  l.headings.push({ id: newHeadingId(l), ...h, children: [] });
  return l;
}

export function addSub(src: Layout, mainId: string, h: Omit<NavSub, 'children' | 'id'>): Layout {
  const l = clone(src);
  const m = l.headings.find((x) => x.id === mainId);
  if (m) m.children.push({ id: newHeadingId(l), ...h, children: [] });
  return l;
}

export function renameHeading(src: Layout, id: string, h: Pick<NavHead, 'name_en' | 'name_ar' | 'icon'>): Layout {
  const l = clone(src);
  const x = findHeading(l, id);
  if (x) Object.assign(x, h);
  return l;
}

/**
 * Deletes a heading, never a screen: the entries of a sub-heading go to its main heading at its place; the entries of a main heading (screens and sub-headings)
 * go to "Other" (created at the end when missing). "Other" itself can be deleted only when it is empty.
 */
export function removeHeading(src: Layout, id: string): Layout | null {
  const l = clone(src);
  const loc = locate(l, headRef(id));
  if (!loc) return null;
  if (loc.kind === 'child') {
    const kids = l.headings[loc.main]!.children;
    const sub = kids[loc.index] as NavSub;
    kids.splice(loc.index, 1, ...sub.children);
    return l;
  }
  if (loc.kind !== 'main') return null;
  const [h] = l.headings.splice(loc.main, 1);
  if (!h!.children.length) return l.headings.length ? l : null;
  if (h!.id === OTHER_ID) return null;
  let other = l.headings.find((x) => x.id === OTHER_ID);
  if (!other) { other = otherHeading(); l.headings.push(other); }
  other.children.push(...h!.children);
  return l;
}

/** Where a node sits, for the announcements: its heading, position and count. */
export function position(l: Layout, ref: Ref): { container: NavHead | NavSub | null; index: number; count: number } | null {
  const loc = locate(l, ref);
  if (!loc) return null;
  if (loc.kind === 'main') return { container: null, index: loc.main + 1, count: l.headings.length };
  const m = l.headings[loc.main]!;
  if (loc.kind === 'child') return { container: m, index: loc.index + 1, count: m.children.length };
  const s = m.children[loc.parent] as NavSub;
  return { container: s, index: loc.index + 1, count: s.children.length };
}
