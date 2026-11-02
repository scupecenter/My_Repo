/**
 * The shared rule language (ADR 0009 section 7) as far as documents need it: all, any, not, eq, in, is_yes, is_na. Evaluated here, never in SQL and never
 * with eval. The answer is true, false, or null when an operand has no value (the PMIS cannot judge: the slot is neither added nor removed, and Data Entry
 * can declare that the document applies). `count` and `lookup` are not evaluated yet and answer null.
 */
export type Rule = Record<string, unknown> | null;
export type Ctx = Record<string, unknown>;

const ROOTS = new Set(['site', 'task', 'scenario', 'procurement', 'record']);

function lookup(path: string, ctx: Ctx): unknown {
  let cur: unknown = ctx;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function operand(x: unknown, ctx: Ctx): unknown {
  if (typeof x === 'string' && ROOTS.has(x.split('.')[0] as string) && x.includes('.')) return lookup(x, ctx);
  if (x === 'scenario') return ctx.scenario;
  return x;
}

const norm = (v: unknown): string => String(v).trim().toLowerCase();
const YES = new Set(['yes', 'true', 'y', '1']);

export function evalRule(rule: unknown, ctx: Ctx, depth = 0): boolean | null {
  if (rule === null || rule === undefined) return true;
  if (typeof rule !== 'object' || Array.isArray(rule) || depth > 8) return null;
  const entries = Object.entries(rule as Record<string, unknown>);
  if (entries.length !== 1) return null;
  const [op, arg] = entries[0] as [string, unknown];
  switch (op) {
    case 'all':
    case 'any': {
      if (!Array.isArray(arg)) return null;
      const parts = arg.map((r) => evalRule(r, ctx, depth + 1));
      if (op === 'all') return parts.includes(false) ? false : parts.includes(null) ? null : true;
      return parts.includes(true) ? true : parts.includes(null) ? null : false;
    }
    case 'not': {
      const r = evalRule(arg, ctx, depth + 1);
      return r === null ? null : !r;
    }
    case 'eq': {
      if (!Array.isArray(arg) || arg.length !== 2) return null;
      const a = operand(arg[0], ctx), b = operand(arg[1], ctx);
      if (a === undefined || a === null || b === undefined) return null;
      return norm(a) === norm(b);
    }
    case 'in': {
      if (!Array.isArray(arg) || arg.length !== 2 || !Array.isArray(arg[1])) return null;
      const a = operand(arg[0], ctx);
      if (a === undefined || a === null) return null;
      return (arg[1] as unknown[]).some((x) => norm(x) === norm(a));
    }
    case 'is_yes': {
      if (typeof arg !== 'string') return null;
      const v = lookup(arg, ctx);
      if (v === undefined || v === null) return null;
      return v === true || YES.has(norm(v));
    }
    case 'is_na': {
      if (typeof arg !== 'string') return null;
      const v = lookup(arg, ctx);
      return v === undefined || v === null || norm(v) === 'na';
    }
    default:
      return null;
  }
}
