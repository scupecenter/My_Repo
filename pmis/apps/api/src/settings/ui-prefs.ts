import { z } from 'zod';

/**
 * The appearance dimensions (owner approval 2026-11-27, the PM-platforms proposal items 1-3; migration 0241, contract 0.15.230).
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
} as const;

export type UiPrefKey = keyof typeof UI_PREF_OPTIONS;
export type UiPrefs = Partial<{ [K in UiPrefKey]: (typeof UI_PREF_OPTIONS)[K][number] }>;

/** The built-in standard of every dimension (ui_pref_defaults() in the database). */
export const UI_PREF_DEFAULTS: Required<UiPrefs> = {
  density: 'standard', font_scale: 'standard', radius: 'standard', motion: 'full', icon_style: 'regular', menu_style: 'default', accent: 'default',
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
}).strict();
