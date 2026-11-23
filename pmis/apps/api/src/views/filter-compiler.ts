import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { likePattern } from '../common/cursor';
import type { FieldError } from '../common/problem';
import { problems } from '../common/problem';

/**
 * F3 (contract 0.15.31, migration 0117): the AND/OR filter builder of saved views, compiled on the server.
 *
 * The client sends a tree (never SQL): a root group {op, items} whose items are conditions {field, operator, value} or groups of conditions
 * (two levels at most). Every field must be in the whitelist of the list screen (FilterCatalog: built from constants in this repository and
 * from the active field definitions); its SQL expression comes from the catalogue, never from the request, and every value is a bound
 * parameter of Prisma.sql. Row security and the caller's regions (B3) are applied by the list query beside the compiled condition, never
 * replaced by it. The database repeats the shape and the limits (sv_check_tree) for what is stored in a view.
 */

export const FILTER_LIMITS = { maxDepth: 2, maxItemsPerGroup: 20, maxGroups: 10, maxConditions: 50, maxValues: 100, maxString: 200, maxParam: 8000 } as const;

export type FilterFieldType = 'text' | 'enum' | 'number' | 'date' | 'bool';
export type FilterOperator =
  | 'is' | 'is_not' | 'in' | 'not_in' | 'contains' | 'not_contains' | 'empty' | 'not_empty'
  | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'between' | 'before' | 'after' | 'in_last_days' | 'in_next_days';

/** The operators of each field type (the builder offers exactly these; anything else is 422 invalid_operator). */
export const OPERATORS: Record<FilterFieldType, readonly FilterOperator[]> = {
  text: ['is', 'is_not', 'in', 'not_in', 'contains', 'not_contains', 'empty', 'not_empty'],
  enum: ['is', 'is_not', 'in', 'not_in', 'empty', 'not_empty'],
  number: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'between', 'empty', 'not_empty'],
  date: ['is', 'before', 'after', 'between', 'in_last_days', 'in_next_days', 'empty', 'not_empty'],
  bool: ['is', 'empty', 'not_empty'],
};

export interface FilterOption { value: string; label_en: string; label_ar?: string | null }

/** The group of a field in the builder's dropdown (0.15.45): a stable key and the two labels. */
export interface FilterGroupInfo { key: string; label_en: string; label_ar: string }

export interface FilterField {
  key: string;
  label_en: string;
  label_ar?: string | null;
  type: FilterFieldType;
  options?: FilterOption[];
  /**
   * 0.15.45: the values of an enum field come from the data or from a list catalogue (they change), so a value that is not in `options` is not an error
   * (it simply matches nothing); only the fixed sets of this repository (scenarios, statuses, regions) and the fixed options of a register field are checked.
   */
  open?: boolean;
  /** 0.15.45: `options` holds the first values only (the data has more than the cap). */
  truncated?: boolean;
  group?: FilterGroupInfo;
  /** 0.15.45 (site360-<menu>): the JOIN the expression needs (one derived table per Master column used), added to the FROM clause by the list. */
  join?: Prisma.Sql;
  /** The SQL of the field, built in this repository from fixed aliases; a field code inside it is a bound parameter. */
  expr: Prisma.Sql;
}

export type FilterCatalog = Map<string, FilterField>;

// ---------------------------------------------------------------------------------------------------------------- shape
const FIELD_ID = /^([a-z][a-z0-9_]{0,60}|[fc]:[a-z][a-z0-9_]{0,60}|ms:[A-Z][A-Z0-9_]{0,30}|m:[0-9]{1,4})$/;
const relDate = z.object({ rel: z.literal('today'), offset: z.number().int().min(-3650).max(3650).optional() }).strict();
const scalar = z.union([z.string().max(FILTER_LIMITS.maxString), z.number().finite(), z.boolean(), relDate]);
const condition = z.object({
  field: z.string().regex(FIELD_ID),
  operator: z.string().regex(/^[a-z_]{2,20}$/),
  value: z.union([scalar, z.array(scalar).max(FILTER_LIMITS.maxValues), z.null()]).optional(),
}).strict();
const subGroup = z.object({ op: z.enum(['and', 'or']), items: z.array(condition).max(FILTER_LIMITS.maxItemsPerGroup) }).strict();
export const filterTreeSchema = z.object({
  op: z.enum(['and', 'or']),
  items: z.array(z.union([condition, subGroup])).max(FILTER_LIMITS.maxItemsPerGroup),
}).strict();

export type FilterCondition = z.infer<typeof condition>;
export type FilterGroup = z.infer<typeof filterTreeSchema>;
type Scalar = z.infer<typeof scalar>;

const isGroup = (x: unknown): x is { op: 'and' | 'or'; items: unknown[] } => !!x && typeof x === 'object' && Array.isArray((x as { items?: unknown }).items);

/**
 * Validates the shape and the limits of a tree. Depth is checked before the schema so a third level answers `too_deep`, not a generic error.
 * `base` is the JSON path of the tree in the request (for the field errors).
 */
export function parseFilterTree(raw: unknown, base = '/filter'): FilterGroup {
  if (isGroup(raw)) {
    let groups = 0, conds = 0;
    for (const [i, it] of raw.items.entries()) {
      if (isGroup(it)) {
        groups++;
        for (const [j, c] of it.items.entries()) {
          if (isGroup(c)) throw problems.validation([{ path: `${base}/items/${i}/items/${j}`, code: 'too_deep', message: `Filters nest ${FILTER_LIMITS.maxDepth} levels at most.` }]);
          conds++;
        }
      } else conds++;
    }
    if (groups > FILTER_LIMITS.maxGroups || conds > FILTER_LIMITS.maxConditions) {
      throw problems.validation([{ path: base, code: 'too_many', message: `At most ${FILTER_LIMITS.maxGroups} groups and ${FILTER_LIMITS.maxConditions} conditions.` }]);
    }
  }
  const r = filterTreeSchema.safeParse(raw);
  if (!r.success) {
    const errors: FieldError[] = r.error.issues.slice(0, 10).map((i) => ({
      path: `${base}${i.path.length ? '/' + i.path.join('/') : ''}`,
      code: i.code === 'too_big' ? 'too_many' : 'invalid',
      message: i.message,
    }));
    throw problems.validation(errors);
  }
  return r.data;
}

/** The `filter` query parameter of a list: a JSON tree in one string. Absent or empty = no filter. */
export function parseFilterParam(raw: unknown): FilterGroup | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > FILTER_LIMITS.maxParam) throw problems.validation([{ path: '/filter', code: 'invalid', message: `filter is a JSON object of at most ${FILTER_LIMITS.maxParam} characters.` }]);
  let json: unknown;
  try {
    json = JSON.parse(v);
  } catch {
    throw problems.validation([{ path: '/filter', code: 'invalid', message: 'filter is not valid JSON.' }]);
  }
  return parseFilterTree(json);
}

/** Every field id of a tree (for the hidden-field check). */
export function treeFields(tree: FilterGroup): string[] {
  const out = new Set<string>();
  for (const it of tree.items) {
    if ('items' in it) for (const c of it.items) out.add(c.field);
    else out.add(it.field);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------- compile
const fail = (path: string, code: string, message: string): never => { throw problems.validation([{ path, code, message }]); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function oneValue(c: FilterCondition, path: string): Scalar {
  const v = c.value;
  if (v === undefined || v === null || Array.isArray(v)) return fail(`${path}/value`, 'invalid_value', 'This operator takes one value.');
  return v;
}
function listValue(c: FilterCondition, path: string): Scalar[] {
  const v = c.value;
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  if (arr.length === 0) return fail(`${path}/value`, 'invalid_value', 'Give at least one value.');
  return arr;
}
function pairValue(c: FilterCondition, path: string): [Scalar, Scalar] {
  const v = c.value;
  if (!Array.isArray(v) || v.length !== 2) return fail(`${path}/value`, 'invalid_value', 'between takes two values [from, to].');
  return [v[0] as Scalar, v[1] as Scalar];
}
const str = (v: Scalar, path: string): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fail(`${path}/value`, 'invalid_value', 'A text value is expected.');
};
const num = (v: Scalar, path: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d{1,15}(\.\d{1,10})?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fail(`${path}/value`, 'invalid_value', 'A number is expected.');
  return n;
};
/** A date value: 'YYYY-MM-DD' or {rel: 'today', offset: days}. The relative date is the business date of the server (cal_today, calc.timezone). */
const dateSql = (v: Scalar, path: string): Prisma.Sql => {
  if (typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)) return Prisma.sql`${v}::date`;
  if (v && typeof v === 'object' && v.rel === 'today') return Prisma.sql`(cal_today() + ${v.offset ?? 0}::int)`;
  return fail(`${path}/value`, 'invalid_value', 'A date (YYYY-MM-DD) or a relative date is expected.');
};
const days = (v: Scalar, path: string): number => {
  const n = num(v, path);
  if (!Number.isInteger(n) || n < 0 || n > 3650) return fail(`${path}/value`, 'invalid_value', 'A number of days from 0 to 3650 is expected.');
  return n;
};
const bool = (v: Scalar, path: string): boolean => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'false') return v === 'true';
  return fail(`${path}/value`, 'invalid_value', 'true or false is expected.');
};

function condSql(c: FilterCondition, f: FilterField, path: string): Prisma.Sql {
  const op = c.operator as FilterOperator;
  if (!(OPERATORS[f.type] as readonly string[]).includes(op)) fail(`${path}/operator`, 'invalid_operator', `${c.operator} is not an operator of a ${f.type} field.`);
  const e = f.expr;
  if (op === 'empty') return f.type === 'text' || f.type === 'enum' ? Prisma.sql`(nullif(${e}, '') IS NULL)` : Prisma.sql`(${e} IS NULL)`;
  if (op === 'not_empty') return f.type === 'text' || f.type === 'enum' ? Prisma.sql`(nullif(${e}, '') IS NOT NULL)` : Prisma.sql`(${e} IS NOT NULL)`;
  const allowed = f.type === 'enum' && !f.open ? new Set((f.options ?? []).map((o) => o.value)) : null;
  const enumStr = (v: Scalar): string => {
    const s = str(v, path);
    if (allowed && !allowed.has(s)) fail(`${path}/value`, 'invalid_value', `${s.slice(0, 40)} is not a value of this field.`);
    return s;
  };
  switch (f.type) {
    case 'text':
    case 'enum': {
      if (op === 'is') return Prisma.sql`(${e} = ${enumStr(oneValue(c, path))})`;
      if (op === 'is_not') return Prisma.sql`(${e} IS DISTINCT FROM ${enumStr(oneValue(c, path))})`;
      if (op === 'in') return Prisma.sql`(${e} = ANY(${listValue(c, path).map(enumStr)}::text[]))`;
      if (op === 'not_in') return Prisma.sql`(NOT coalesce(${e} = ANY(${listValue(c, path).map(enumStr)}::text[]), false))`;
      if (op === 'contains') return Prisma.sql`(${e} ILIKE ${likePattern(str(oneValue(c, path), path))})`;
      return Prisma.sql`(coalesce(${e} NOT ILIKE ${likePattern(str(oneValue(c, path), path))}, true))`; // not_contains
    }
    case 'number': {
      if (op === 'between') { const [a, b] = pairValue(c, path); return Prisma.sql`(${e} BETWEEN ${num(a, path)}::numeric AND ${num(b, path)}::numeric)`; }
      const n = num(oneValue(c, path), path);
      if (op === 'ne') return Prisma.sql`(${e} IS DISTINCT FROM ${n}::numeric)`;
      const sym = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[op as 'eq' | 'lt' | 'lte' | 'gt' | 'gte'];
      return Prisma.sql`(${e} ${Prisma.raw(sym)} ${n}::numeric)`;
    }
    case 'date': {
      if (op === 'between') { const [a, b] = pairValue(c, path); return Prisma.sql`(${e} BETWEEN ${dateSql(a, path)} AND ${dateSql(b, path)})`; }
      if (op === 'in_last_days') return Prisma.sql`(${e} BETWEEN cal_today() - ${days(oneValue(c, path), path)}::int AND cal_today())`;
      if (op === 'in_next_days') return Prisma.sql`(${e} BETWEEN cal_today() AND cal_today() + ${days(oneValue(c, path), path)}::int)`;
      const d = dateSql(oneValue(c, path), path);
      if (op === 'before') return Prisma.sql`(${e} < ${d})`;
      if (op === 'after') return Prisma.sql`(${e} > ${d})`;
      return Prisma.sql`(${e} = ${d})`; // is
    }
    case 'bool':
      return Prisma.sql`(${e} = ${bool(oneValue(c, path), path)})`;
  }
  return fail(path, 'invalid', 'Unknown field type.');
}

function groupSql(g: { op: 'and' | 'or'; items: (FilterCondition | { op: 'and' | 'or'; items: FilterCondition[] })[] }, catalog: FilterCatalog, path: string): Prisma.Sql {
  const parts = g.items.map((it, i) => {
    const p = `${path}/items/${i}`;
    if ('items' in it) return groupSql(it, catalog, p);
    const f = catalog.get(it.field);
    if (!f) return fail(`${p}/field`, 'unknown_field', `${it.field} is not a filter field of this list.`);
    return condSql(it, f, p);
  });
  if (parts.length === 0) return Prisma.sql`TRUE`;
  return Prisma.sql`(${Prisma.join(parts, g.op === 'or' ? ' OR ' : ' AND ')})`;
}

/**
 * Compiles a validated tree against the catalogue of the list. `hidden` holds the field ids the caller may not see (sv_filter_hidden):
 * they answer unknown_field, exactly like a field outside the whitelist, so the answer never tells that a hidden field exists.
 */
export function compileFilter(tree: FilterGroup, catalog: FilterCatalog, hidden: readonly string[] = [], base = '/filter'): Prisma.Sql {
  if (hidden.length) {
    const h = new Set(hidden);
    const visible: FilterCatalog = new Map([...catalog].filter(([k]) => !h.has(k)));
    return groupSql(tree, visible, base);
  }
  return groupSql(tree, catalog, base);
}

/** What the builder needs of a field (the SQL never leaves the server). */
export function fieldDto(f: FilterField): Record<string, unknown> {
  return {
    key: f.key, label_en: f.label_en, label_ar: f.label_ar ?? null, type: f.type, operators: OPERATORS[f.type],
    ...(f.group ? { group: f.group } : {}),
    ...(f.options ? { options: f.options, truncated: f.truncated === true } : {}),
  };
}
