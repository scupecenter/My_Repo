/**
 * Conditional formatting rules (decision 2026-11-28): a person's own rules per table, each "when this column's value meets this condition, colour the
 * cell (or the whole row)", for example "Due date more than 7 days past: red". Kept with the table's column prefs (this browser) and saved with a view.
 * Display only: the stored values and every check stay the same. The colours are the status tones the app already uses (late, wait, done, open).
 * Pure: no React here.
 */
export const RULE_TONES = ['red', 'amber', 'green', 'blue', 'grey'] as const;
export type RuleTone = (typeof RULE_TONES)[number];
export const RULE_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'contains', 'empty', 'notempty', 'days_past', 'days_ahead'] as const;
export type RuleOp = (typeof RULE_OPS)[number];
export type FormatRule = { id: string; col: string; op: RuleOp; value?: string | number; tone: RuleTone; scope: 'cell' | 'row' };
export const MAX_RULES = 20;
/** the kind of value a column holds, which decides the conditions offered */
export type RuleKind = 'number' | 'date' | 'text' | 'list';
export const OPS_OF: Record<RuleKind, RuleOp[]> = {
  number: ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'empty', 'notempty'],
  date: ['days_past', 'days_ahead', 'empty', 'notempty'],
  text: ['contains', 'eq', 'ne', 'empty', 'notempty'],
  list: ['eq', 'ne', 'empty', 'notempty'],
};
export const needsValue = (op: RuleOp) => op !== 'empty' && op !== 'notempty';
/** Tailwind classes of a tone: the app's own status backgrounds and inks */
export const TONE_CLASS: Record<RuleTone, string> = {
  red: 'bg-lateBg text-lateInk', amber: 'bg-waitBg text-waitInk', green: 'bg-doneBg text-doneInk', blue: 'bg-openBg text-openInk', grey: 'bg-card2 text-mute',
};

const isTone = (x: unknown): x is RuleTone => (RULE_TONES as readonly unknown[]).includes(x);
const isOp = (x: unknown): x is RuleOp => (RULE_OPS as readonly unknown[]).includes(x);

/** Only well-formed rules (a stored or saved value from another build is dropped, never trusted). */
export function cleanRules(x: unknown): FormatRule[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: FormatRule[] = [];
  for (const r of x.slice(0, MAX_RULES)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.col !== 'string' || !o.col || !isOp(o.op) || !isTone(o.tone)) continue;
    const value = typeof o.value === 'number' && Number.isFinite(o.value) ? o.value : typeof o.value === 'string' ? o.value.slice(0, 120) : undefined;
    if (needsValue(o.op) && (value === undefined || value === '')) continue;
    out.push({ id: o.id.slice(0, 40), col: o.col.slice(0, 80), op: o.op, ...(needsValue(o.op) ? { value } : {}), tone: o.tone, scope: o.scope === 'row' ? 'row' : 'cell' });
  }
  return out.length ? out : undefined;
}

const DAY = 86_400_000;
/** whole days from today to the date (negative = past), null when the value is not a date */
export function daysFromToday(v: unknown, now: Date): number | null {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / DAY);
}
const blank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Does the value meet the rule's condition? `shown` is the text the cell shows (for "contains" and list labels). */
export function ruleMatches(rule: FormatRule, v: unknown, now: Date, shown?: string): boolean {
  if (rule.op === 'empty') return blank(v);
  if (rule.op === 'notempty') return !blank(v);
  if (blank(v)) return false;
  const n = Number(rule.value);
  switch (rule.op) {
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const x = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(x) || !Number.isFinite(n)) return false;
      return rule.op === 'gt' ? x > n : rule.op === 'gte' ? x >= n : rule.op === 'lt' ? x < n : x <= n;
    }
    case 'eq': case 'ne': {
      const same = (Array.isArray(v) ? v.map(String) : [String(v), ...(shown ? [shown] : [])]).some((s) => s.toLowerCase() === String(rule.value).toLowerCase());
      return rule.op === 'eq' ? same : !same;
    }
    case 'contains': return (shown ?? String(v)).toLowerCase().includes(String(rule.value).toLowerCase());
    case 'days_past': { const d = daysFromToday(v, now); return d !== null && Number.isFinite(n) && -d > n; }
    case 'days_ahead': { const d = daysFromToday(v, now); return d !== null && Number.isFinite(n) && d >= 0 && d <= n; }
    default: return false;
  }
}

/** The first rule of the column that the value meets (rules apply in the order the person listed them). */
export function cellRule(rules: readonly FormatRule[] | undefined, col: string, v: unknown, now: Date, shown?: string): FormatRule | undefined {
  return rules?.find((r) => r.col === col && ruleMatches(r, v, now, shown));
}
/** The first whole-row rule that a row meets. `valueOf` gives the value and shown text of a column of the row. */
export function rowRule(rules: readonly FormatRule[] | undefined, valueOf: (col: string) => { v: unknown; shown?: string }, now: Date): FormatRule | undefined {
  return rules?.find((r) => r.scope === 'row' && (() => { const x = valueOf(r.col); return ruleMatches(r, x.v, now, x.shown); })());
}

/** Inline colours of a tone for a grid cell or row (the app's own status tokens; inline so they win over the zebra and hover rows). */
export const TONE_STYLE: Record<RuleTone, { background: string; color: string }> = {
  red: { background: 'var(--lateBg)', color: 'var(--lateInk)' }, amber: { background: 'var(--waitBg)', color: 'var(--waitInk)' },
  green: { background: 'var(--doneBg)', color: 'var(--doneInk)' }, blue: { background: 'var(--openBg)', color: 'var(--openInk)' }, grey: { background: 'var(--card2)', color: 'var(--mute)' },
};
