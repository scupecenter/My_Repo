/**
 * Appearance profiles (owner approval 2026-11-27, the improvement proposal items 1-3; migration 0241, contract 0.15.230).
 * Eight dimensions, each changeable alone, applied at once on <html> as data-ui-* attributes; the token blocks live in styles/appearance.css.
 * The effective set comes from the server (GET /me user.appearance: own choices, else the organization defaults); the last seen set is cached
 * so a reload does not flash. Independent of the UI design (brand) and of the light/dark theme.
 */
import { currentMotion } from './motion';

export const APPEARANCE_OPTIONS = {
  density: ['comfortable', 'standard', 'compact'],
  font_scale: ['small', 'standard', 'large'],
  radius: ['sharp', 'standard', 'rounded'],
  motion: ['full', 'reduced'],
  icon_style: ['light', 'regular', 'bold'],
  menu_style: ['default', 'rail', 'autohide'],
  accent: ['default', 'teal', 'blue', 'violet', 'green', 'orange', 'red', 'amber'],
  contrast: ['standard', 'high'], // 0347 (item 19): the high-contrast mode
  inbox_panel: ['overlay', 'floating', 'docked'], // 0526: the notification panel as an overlay, a movable floating window or docked at the edge
  more_menu: ['list', 'grid'], // 0581: the More menu of the table screens as a list or an icon grid with search
  app_banner: ['show', 'hide'], // 0654: the app banner (install the app) on small screens
  first_use_tour: ['auto', 'manual'], // 0654: the first-use tour opens by itself once (auto) or only when replayed (manual)
  inbox_anchor: ['end-top', 'end-bottom', 'start-top', 'start-bottom'], // 0526: the corner of the floating panel (a drag snaps to the nearest)
} as const;

export type AppearanceKey = keyof typeof APPEARANCE_OPTIONS;
export type Appearance = Partial<{ [K in AppearanceKey]: (typeof APPEARANCE_OPTIONS)[K][number] }>;

/** The built-in standard of every dimension (ui_pref_defaults() in the database). */
export const APPEARANCE_DEFAULTS: Required<Appearance> = {
  density: 'standard', font_scale: 'standard', radius: 'standard', motion: 'full', icon_style: 'regular', menu_style: 'default', accent: 'default', contrast: 'standard', inbox_panel: 'overlay', inbox_anchor: 'end-top', more_menu: 'list', app_banner: 'show', first_use_tour: 'auto',
};

/** The ready-made profiles of proposal item 1; the theme flips for `night` are saved through the profile like the theme button. */
export const APPEARANCE_PRESETS: Record<'classic' | 'comfortable' | 'night' | 'compact', { theme: 'light' | 'dark'; prefs: Appearance }> = {
  classic: { theme: 'light', prefs: { density: 'standard', font_scale: 'small', radius: 'sharp', motion: 'full', icon_style: 'light', menu_style: 'default', accent: 'default', contrast: 'standard' } },
  comfortable: { theme: 'light', prefs: { density: 'comfortable', font_scale: 'standard', radius: 'rounded', motion: 'full', icon_style: 'regular', menu_style: 'default', accent: 'default', contrast: 'standard' } },
  night: { theme: 'dark', prefs: { density: 'standard', font_scale: 'standard', radius: 'standard', motion: 'reduced', icon_style: 'regular', menu_style: 'default', accent: 'blue', contrast: 'standard' } },
  compact: { theme: 'light', prefs: { density: 'compact', font_scale: 'small', radius: 'sharp', motion: 'reduced', icon_style: 'light', menu_style: 'rail', accent: 'default', contrast: 'standard' } },
};

const KEY = 'pmis.appearance';

export const isAppearanceValue = (k: AppearanceKey, v: unknown): v is string =>
  typeof v === 'string' && (APPEARANCE_OPTIONS[k] as readonly string[]).includes(v);

/** Keeps only known keys with allowed values (server data is already sanitized; this guards the cache). */
export function sanitizeAppearance(raw: unknown): Appearance {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Appearance = {};
  for (const k of Object.keys(APPEARANCE_OPTIONS) as AppearanceKey[]) {
    const v = (raw as Record<string, unknown>)[k];
    if (isAppearanceValue(k, v)) (out as Record<string, string>)[k] = v;
  }
  return out;
}

/** Sets the data-ui-* attributes on <html> (a dimension at its standard has no attribute, so the base tokens apply exactly as before) and remembers the set. */
export function applyAppearance(prefs: Appearance | null | undefined): void {
  const p = sanitizeAppearance(prefs ?? {});
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage blocked: the attributes still apply */ }
  paint(p);
}

/** Paints the attributes without touching the cache (the live preview uses this). */
export function paint(prefs: Appearance): void {
  const el = document.documentElement;
  for (const k of Object.keys(APPEARANCE_OPTIONS) as AppearanceKey[]) {
    const v = prefs[k];
    // `motion` reuses the unified motion system (#274: data-motion + styles/motion.css): the profile's
    // `reduced` forces reduced; `full` (the standard) leaves the browser choice (Settings > Screens > Motion).
    if (k === 'motion') {
      if (v === 'reduced' || currentMotion() === 'reduced') el.setAttribute('data-motion', 'reduced');
      else el.removeAttribute('data-motion');
      continue;
    }
    if (v === undefined || v === APPEARANCE_DEFAULTS[k]) el.removeAttribute(`data-ui-${k.replace('_', '-')}`);
    else el.setAttribute(`data-ui-${k.replace('_', '-')}`, v);
  }
}

/** The set used before /me answers (the last one seen on this browser), so a reload does not flash the default. */
export function savedAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sanitizeAppearance(JSON.parse(raw)) : {};
  } catch { return {}; }
}
