/**
 * Site Master menus (F15, contract 0.15.21, migration 0101). Pure functions: the menus of a Master column and the 3-level
 * grid header (phase band, group, field). A column may belong to several menus (owner decision 2026-11-15): the database
 * holds the set (master_columns.site_master_sections), the defaults below are the same ranges as the migration.
 */

export const SITE_MASTER_SECTIONS = ['design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om', 'status'] as const;
export type SiteMasterSection = (typeof SITE_MASTER_SECTIONS)[number];

/** The menus a column can be added to or removed from. status is fixed: it is in every menu. */
export const SITE_MASTER_MOVABLE = ['design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om'] as const;

export const SITE_MASTER_MENUS = [
  { key: 'master', name_en: 'Master', name_ar: 'الماستر' },
  { key: 'design_acq', name_en: 'Design & Acquisition', name_ar: 'التصميم والاستحواذ' },
  { key: 'sow', name_en: 'SOW', name_ar: 'نطاق العمل' },
  { key: 'cw', name_en: 'CW', name_ar: 'الأعمال المدنية' },
  { key: 'te', name_en: 'TE', name_ar: 'التركيبات' },
  { key: 'hoto', name_en: 'HOTO', name_ar: 'التسليم والإغلاق' },
  { key: 'dismantle', name_en: 'Dismantle', name_ar: 'الفك' },
  { key: 'om', name_en: 'O&M', name_ar: 'التشغيل والصيانة' },
] as const;
export type SiteMasterMenu = (typeof SITE_MASTER_MENUS)[number]['key'];

/** Identity columns that every menu shows and freezes by default: # (A = 1) to Site Name (D = 4). */
export const SITE_MASTER_IDENTITY_ORDS = [1, 2, 3, 4] as const;
export const SITE_MASTER_PHASE_GATE = 'Phase Gate';

/** Default menus by Master order (A = 1). Mirrors migration 0101, which is the seed. */
export const SITE_MASTER_DEFAULT_RANGES: ReadonlyArray<readonly [number, number, SiteMasterSection]> = [
  [1, 22, 'design_acq'],
  [23, 23, 'cw'],
  [24, 32, 'sow'],
  [33, 77, 'cw'],
  [78, 143, 'te'],
  [144, 156, 'hoto'],
  [157, 169, 'om'],
  [170, 179, 'dismantle'],
  [180, 187, 'status'],
];

export interface SiteMasterColumnRow {
  ord: number;
  letter: string;
  group_top: string | null;
  group_mid: string | null;
  header: string;
  /** The menus of the column (a set; status means every menu). */
  sections: SiteMasterSection[];
  /** The kind of source of the column (0.15.35, migration 0121); not_tracked: no source in the system. Absent in pure tests. */
  source_kind?: SiteMasterSourceKind;
  /** A short English note of the column's rule (0.15.35). */
  source_note?: string | null;
  /** 0133 (0.15.43): the place on the grid (the columns of a menu are listed in this order); equals ord until a column is added after another. */
  display_order?: number;
  name_ar?: string | null;
  /** The effective value type (a task input column reads its input) and its dropdown list. */
  value_type?: 'text' | 'number' | 'date' | 'list' | 'yes_no';
  list_catalogue?: string | null;
  is_added?: boolean;
}

/** Display order of a column (the Master order when it has none). */
export const displayOrder = (c: { ord: number; display_order?: number }): number => c.display_order ?? c.ord;

/** The kinds of source of a Master column or cell (0.15.35, migration 0121). */
export const SITE_MASTER_SOURCE_KINDS = ['site', 'task', 'milestone', 'register', 'baseline', 'derived', 'custom_field', 'not_tracked'] as const;
export type SiteMasterSourceKind = (typeof SITE_MASTER_SOURCE_KINDS)[number];

export interface SiteMasterBand {
  name: string | null;
  is_phase_gate: boolean;
  groups: { name: string | null; ords: number[] }[];
}

export interface SiteMasterMenuItem {
  key: SiteMasterMenu;
  name_en: string;
  name_ar: string;
  columns: (SiteMasterColumnRow & { is_phase_gate: boolean })[];
  bands: SiteMasterBand[];
  frozen_ords: number[];
}

/** Column letter (A, Z, AA, GE) to Master order (1-based). */
export function colLetterToOrd(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) {
    const c = ch.charCodeAt(0) - 64;
    if (c < 1 || c > 26) throw new Error(`invalid column letter: ${letter}`);
    n = n * 26 + c;
  }
  return n;
}

/** The default menus of each Master order 1..187 (one menu per column from the ranges). */
export function defaultSectionsByOrd(): Map<number, SiteMasterSection[]> {
  const m = new Map<number, SiteMasterSection[]>();
  for (const [from, to, s] of SITE_MASTER_DEFAULT_RANGES) for (let o = from; o <= to; o++) m.set(o, [s]);
  return m;
}

/** The columns of one menu in display order (the Master order until a column is added after another): Master lists all; a menu lists the columns that carry it, the status columns and the identity. */
export function menuColumns<T extends SiteMasterColumnRow>(menu: SiteMasterMenu, columns: readonly T[]): T[] {
  const sorted = [...columns].sort((a, b) => displayOrder(a) - displayOrder(b) || a.ord - b.ord);
  if (menu === 'master') return sorted;
  return sorted.filter(
    (c) => c.sections.includes(menu) || c.sections.includes('status') || (SITE_MASTER_IDENTITY_ORDS as readonly number[]).includes(c.ord),
  );
}

/**
 * The 3-level grid header of a list of columns (in Master order): a band is a run of columns with the same phase band,
 * a group is a run inside it with the same group, and the field is the column itself (its ord).
 */
export function buildBands(columns: readonly SiteMasterColumnRow[]): SiteMasterBand[] {
  const bands: SiteMasterBand[] = [];
  for (const c of columns) {
    let band = bands[bands.length - 1];
    if (!band || band.name !== c.group_top) {
      band = { name: c.group_top, is_phase_gate: c.group_top === SITE_MASTER_PHASE_GATE, groups: [] };
      bands.push(band);
    }
    let group = band.groups[band.groups.length - 1];
    if (!group || group.name !== c.group_mid) {
      group = { name: c.group_mid, ords: [] };
      band.groups.push(group);
    }
    group.ords.push(c.ord);
  }
  return bands;
}

const MENU_NAMES = new Map<string, { name_en: string; name_ar: string }>(SITE_MASTER_MENUS.map((m) => [m.key, m]));

/** One Site Master menu, ready for the grid: its columns, header bands and frozen identity columns. */
export function buildMenu(menu: SiteMasterMenu, columns: readonly SiteMasterColumnRow[]): SiteMasterMenuItem {
  const cols = menuColumns(menu, columns);
  const names = MENU_NAMES.get(menu)!;
  return {
    key: menu,
    name_en: names.name_en,
    name_ar: names.name_ar,
    columns: cols.map((c) => ({ ...c, is_phase_gate: c.group_top === SITE_MASTER_PHASE_GATE })),
    bands: buildBands(cols),
    frozen_ords: cols.map((c) => c.ord).filter((o) => (SITE_MASTER_IDENTITY_ORDS as readonly number[]).includes(o)),
  };
}

/** All seven menus plus Master, in menu order. */
export function buildSiteMaster(columns: readonly SiteMasterColumnRow[]): SiteMasterMenuItem[] {
  return SITE_MASTER_MENUS.map((m) => buildMenu(m.key, columns));
}
