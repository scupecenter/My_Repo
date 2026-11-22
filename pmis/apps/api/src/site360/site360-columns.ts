/**
 * Workflow Studio S2 (contract 0.15.43, migration 0132): the pure parts of the Site Master column administration. The database doors
 * (site360_column_*) decide every rule; these functions only shape the request, the answer and the place picker.
 */
import { z } from 'zod';

export const SITE360_COLUMN_TYPES = [
  'text',
  'number',
  'date',
  'list',
  'yes_no',
] as const;
export type Site360ColumnType = (typeof SITE360_COLUMN_TYPES)[number];

const reason = z.string().trim().min(3).max(1000);
const type = z.enum(SITE360_COLUMN_TYPES);
const menu = z.enum([
  'design_acq',
  'sow',
  'cw',
  'te',
  'hoto',
  'dismantle',
  'om',
]);
const taskInput = z
  .object({
    kind: z.literal('task_input'),
    task_code: z.string().trim().min(1).max(40),
    field_key: z
      .string()
      .regex(
        /^(planned_date|planned_start|actual_start|actual_date|submitted_date|approved_date|external_party|v:[a-z0-9_]{1,60})$/,
      )
      .optional(),
  })
  .strict();
const siteField = z
  .object({ kind: z.literal('site_field'), field_id: z.string().uuid() })
  .strict();

export const createColumnBody = z
  .object({
    name_en: z.string().trim().min(1).max(120),
    name_ar: z.string().trim().max(120).nullable().optional(),
    group_top: z.string().trim().min(1).max(80),
    group_mid: z.string().trim().max(80).nullable().optional(),
    after_ord: z.number().int().min(1).max(1000),
    value_type: type.optional(),
    list_catalogue: z.string().min(1).max(60).nullable().optional(),
    source: z.discriminatedUnion('kind', [taskInput, siteField]),
    sections: z
      .array(menu)
      .min(1)
      .max(7)
      .refine(
        (a) => new Set(a).size === a.length,
        'The menus must be different.',
      )
      .optional(),
    reason,
  })
  .strict();

export const updateColumnBody = z
  .object({
    name_en: z.string().trim().min(1).max(120).optional(),
    name_ar: z.string().trim().max(120).nullable().optional(),
    group_top: z.string().trim().min(1).max(80).optional(),
    group_mid: z.string().trim().max(80).nullable().optional(),
    after_ord: z.number().int().min(1).max(1000).optional(),
    value_type: type.optional(),
    list_catalogue: z.string().min(1).max(60).nullable().optional(),
    confirm_unconvertible: z.boolean().optional(),
    reason,
  })
  .strict()
  .refine(
    (b) =>
      Object.keys(b).some(
        (k) => k !== 'reason' && k !== 'confirm_unconvertible',
      ),
    { message: 'Send at least one key to change.', path: ['name_en'] },
  );

export const previewBody = z
  .object({
    value_type: type,
    list_catalogue: z.string().min(1).max(60).nullable().optional(),
  })
  .strict();
export const reasonBody = z.object({ reason }).strict();

export interface ColumnAdminRow {
  ord: number;
  group_top: string | null;
  group_mid: string | null;
  is_active: boolean;
}

export interface ColumnBand {
  name: string | null;
  groups: (string | null)[];
}

/** The bands and groups of the active columns in display order (to choose the place of a new column): a band once, its groups once, in the order they first appear. */
export function buildColumnBands(
  items: readonly ColumnAdminRow[],
): ColumnBand[] {
  const bands: ColumnBand[] = [];
  for (const c of items) {
    if (!c.is_active) continue;
    let b = bands.find((x) => x.name === c.group_top);
    if (!b) {
      b = { name: c.group_top, groups: [] };
      bands.push(b);
    }
    if (!b.groups.includes(c.group_mid)) b.groups.push(c.group_mid);
  }
  return bands;
}

/** The query flag include_inactive: true by default; anything else than true or false is refused by the caller. */
export function parseIncludeInactive(v: unknown): boolean | null {
  if (v === undefined) return true;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}
