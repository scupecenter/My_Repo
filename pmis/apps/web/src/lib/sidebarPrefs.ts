import type { components } from '@/api/schema';
import type { Layout, NavSub } from './navLayout';

/**
 * The personal sidebar (owner approval 2026-11-27, the improvement proposal item 4; migration 0242, contract 0.15.231).
 * The choices save in the profile (ui_prefs.sidebar), so they follow the user to every device; the organization layout and the
 * server's permission list still apply first, the overlay only hides screens, reorders them inside their heading, restyles the
 * badges and pins shortcuts.
 */
export type UiNav = components['schemas']['UiNav'];
export type BadgeStyle = NonNullable<UiNav['badge_style']>;
export const BADGE_STYLES: BadgeStyle[] = ['full', 'dot', 'none'];

/** Screens a person can never hide: Dashboard is the fixed first entry of the menu (it is the way home). */
export const NEVER_HIDDEN: readonly string[] = ['dashboard'];
export const isHideable = (key: string) => !NEVER_HIDDEN.includes(key);
/** Device-local choice (Profile, My sidebar): whether the search box (Ctrl+K) also finds the screens hidden from the menu. Off by default. */
export const PALETTE_HIDDEN_KEY = 'pmis.palette.include_hidden';

const KEY = /^[a-z0-9_.]{1,60}$/;
const cleanList = (v: unknown, max: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string' && KEY.test(x) && !seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out.slice(0, max);
};

/** Keeps only the known keys with allowed values (server data is already checked; this guards older cached copies). */
export function sanitizeUiNav(raw: unknown): UiNav {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: UiNav = {};
  const bs = r.badge_style;
  if (bs === 'full' || bs === 'dot' || bs === 'none') out.badge_style = bs;
  if (r.mode === 'pinned' || r.mode === 'autohide') out.mode = r.mode;
  const hidden = cleanList(r.hidden, 200)?.filter(isHideable); if (hidden) out.hidden = hidden;
  const order = cleanList(r.order, 200); if (order) out.order = order;
  const pins = cleanList(r.pins, 20); if (pins) out.pins = pins;
  return out;
}

const isSub = (c: string | NavSub): c is NavSub => typeof c === 'object' && c !== null;

/** The permitted screens minus the ones the person hid (the screens the menu shows), for the search box and the group pages. */
export const withoutHidden = <T extends { key: string }>(items: T[], prefs: UiNav | null | undefined): T[] => {
  const h = new Set(sanitizeUiNav(prefs ?? {}).hidden ?? []);
  return items.filter((i) => !h.has(i.key));
};

/**
 * The personal overlay over the organization layout: a hidden screen drops out; the `order` list sorts the screens of each
 * heading and sub-heading (the named screens first, in the list's order; the rest keep the organization order). Headings and
 * sub-headings themselves stay where the organization put them.
 */
export function applySidebarOverlay(layout: Layout, prefs: UiNav | null | undefined): Layout {
  const p = sanitizeUiNav(prefs ?? {});
  const hidden = new Set(p.hidden ?? []);
  const rank = new Map((p.order ?? []).map((k, i) => [k, i] as const));
  const sortKeys = (keys: string[]): string[] => {
    const kept = keys.filter((k) => !hidden.has(k));
    if (!rank.size) return kept;
    return kept
      .map((k, i) => [k, i] as const)
      .sort((a, b) => {
        const ra = rank.get(a[0]);
        const rb = rank.get(b[0]);
        if (ra === undefined && rb === undefined) return a[1] - b[1];
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      })
      .map(([k]) => k);
  };
  const applyTo = (children: (string | NavSub)[]): (string | NavSub)[] => {
    // the sorted screens fill the screen slots in order; a hidden screen's slot disappears; a sub-heading stays in its place
    const sorted = sortKeys(children.filter((c): c is string => typeof c === 'string'));
    let i = 0;
    const out: (string | NavSub)[] = [];
    for (const c of children) {
      if (isSub(c)) { out.push({ ...c, children: sortKeys(c.children) }); continue; }
      if (hidden.has(c)) continue;
      out.push(sorted[i++]!);
    }
    return out;
  };
  return { headings: layout.headings.map((h) => ({ ...h, children: applyTo(h.children) })) };
}
