import { z } from 'zod';

/**
 * The appearance dimensions (owner approval 2026-11-27, the improvement proposal items 1-3; migration 0241, contract 0.15.230).
 * The same list lives in the database (ui_pref_options()): keep the two in sync. `accent` `default` = the accent of the design.
 */
export const UI_PREF_OPTIONS = {
  density: ['comfortable', 'standard', 'compact'],
  font_scale: ['small', 'standard', 'large'],
  radius: ['sharp', 'standard', 'rounded'],
  motion: ['full', 'reduced'],
  icon_style: ['light', 'regular', 'bold'],
  menu_style: ['default', 'rail', 'autohide'],
  accent: ['default', 'teal', 'blue', 'violet', 'green', 'orange', 'red', 'amber'],
  contrast: ['standard', 'high'], // 0347 (item 19): the high-contrast mode
  inbox_panel: ['overlay', 'floating', 'docked'], // 0526: the notification panel as an overlay, a floating window or docked
  more_menu: ['list', 'grid'], // 0581: the More menu of the table screens as a list or an icon grid with search
  inbox_anchor: ['end-top', 'end-bottom', 'start-top', 'start-bottom'], // 0526: the corner of the floating panel
} as const;

export type UiPrefKey = keyof typeof UI_PREF_OPTIONS;
export type UiPrefs = Partial<{ [K in UiPrefKey]: (typeof UI_PREF_OPTIONS)[K][number] }>;

/** The built-in standard of every dimension (ui_pref_defaults() in the database). */
export const UI_PREF_DEFAULTS: Required<UiPrefs> = {
  density: 'standard', font_scale: 'standard', radius: 'standard', motion: 'full', icon_style: 'regular', menu_style: 'default', accent: 'default', contrast: 'standard', inbox_panel: 'overlay', inbox_anchor: 'end-top', more_menu: 'list',
};

/** A subset of the dimensions, each with one of its allowed values (PATCH /me/profile ui_prefs, PUT /settings/identity defaults). */
export const uiPrefsSchema = z.object({
  density: z.enum(UI_PREF_OPTIONS.density).optional(),
  font_scale: z.enum(UI_PREF_OPTIONS.font_scale).optional(),
  radius: z.enum(UI_PREF_OPTIONS.radius).optional(),
  motion: z.enum(UI_PREF_OPTIONS.motion).optional(),
  icon_style: z.enum(UI_PREF_OPTIONS.icon_style).optional(),
  menu_style: z.enum(UI_PREF_OPTIONS.menu_style).optional(),
  accent: z.enum(UI_PREF_OPTIONS.accent).optional(),
  contrast: z.enum(UI_PREF_OPTIONS.contrast).optional(),
  inbox_panel: z.enum(UI_PREF_OPTIONS.inbox_panel).optional(),
  inbox_anchor: z.enum(UI_PREF_OPTIONS.inbox_anchor).optional(),
  more_menu: z.enum(UI_PREF_OPTIONS.more_menu).optional(),
}).strict();

/**
 * 0242 (proposal item 4): the personal sidebar, the key `sidebar` of ui_prefs. `hidden` the screens the menu does not show,
 * `order` their order inside their heading (a screen the list does not name keeps the organization order, after the named ones),
 * `badge_style` how the count badges draw (full = the number, dot = a dot, none = no badge), `pins` the pinned shortcuts on top
 * (at most 20). A menu key is a short lowercase id; the web knows the real list and ignores a key it does not have.
 */
export const UI_NAV_BADGE_STYLES = ['full', 'dot', 'none'] as const;
export type UiNavBadgeStyle = (typeof UI_NAV_BADGE_STYLES)[number];
const NAV_KEY = /^[a-z0-9_.]{1,60}$/;
const navKeyList = (max: number) => z.array(z.string().regex(NAV_KEY)).max(max);
export const uiNavSchema = z.object({
  hidden: navKeyList(200).optional(),
  order: navKeyList(200).optional(),
  badge_style: z.enum(UI_NAV_BADGE_STYLES).optional(),
  pins: navKeyList(20).optional(),
}).strict();
export type UiNav = z.infer<typeof uiNavSchema>;

/** PATCH /me/profile ui_prefs: the appearance dimensions plus the personal sidebar (never an organization default). */
export const profileUiPrefsSchema = uiPrefsSchema.extend({ sidebar: uiNavSchema.optional() }).strict();
export type ProfileUiPrefs = z.infer<typeof profileUiPrefsSchema>;
