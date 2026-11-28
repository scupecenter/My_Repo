/**
 * The measure rule of a weight item (Settings > Weight Sets), as a structure instead of raw JSON.
 * The dashboard reads it as {"method":"tasks","tasks":[codes],"plan":"MS3"}, {"method":"none","central":true} or {"method":"register","register":key}.
 * A rule that is empty means "not counted automatically". The server checks the same shape when a draft is published (weight_set_errors).
 */
export type RuleMethod = 'none' | 'tasks' | 'register';
export const RULE_METHODS: RuleMethod[] = ['none', 'tasks', 'register'];
export interface Rule { method: RuleMethod; tasks: string[]; plan: string; central: boolean; register: string; }
export const EMPTY_RULE: Rule = { method: 'none', tasks: [], plan: '', central: false, register: '' };
const PLAN_RE = /^MS([1-9]|10)$/;

/** The stored text -> the structure. `legacy` is true when the text is not a rule object (old free text or broken JSON): the editor shows it and asks to rebuild. */
export function parseRule(text: string | null | undefined): { rule: Rule | null; legacy: boolean } {
  const raw = (text ?? '').trim();
  if (!raw) return { rule: null, legacy: false };
  try {
    const o = JSON.parse(raw) as unknown;
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return { rule: null, legacy: true };
    const r = o as Record<string, unknown>;
    const method = RULE_METHODS.includes(r.method as RuleMethod) ? (r.method as RuleMethod) : 'none';
    return {
      rule: {
        method,
        tasks: Array.isArray(r.tasks) ? r.tasks.filter((x): x is string => typeof x === 'string') : [],
        plan: typeof r.plan === 'string' ? r.plan : '',
        central: r.central === true,
        register: typeof r.register === 'string' ? r.register : '',
      },
      legacy: typeof r.method === 'string' && !RULE_METHODS.includes(r.method as RuleMethod),
    };
  } catch {
    return { rule: null, legacy: true };
  }
}

/** The structure -> the stored text (null for "not counted automatically"). Key order is fixed so a draft compares equal to the set in force. */
export function serializeRule(r: Rule | null): string | null {
  if (!r) return null;
  if (r.method === 'tasks') return JSON.stringify({ method: 'tasks', tasks: r.tasks, ...(r.plan ? { plan: r.plan } : {}) });
  if (r.method === 'register') return JSON.stringify({ method: 'register', register: r.register.trim(), ...(r.central ? { central: true } : {}) });
  return JSON.stringify({ method: 'none', ...(r.central ? { central: true } : {}) });
}

export type RuleError = 'legacy' | 'no_tasks' | 'unknown_task' | 'bad_plan' | 'no_register';
/** What is wrong with the rule, for the screen. `known` is the task codes of the workflow in force (when it could be read). */
export function ruleErrors(text: string | null | undefined, known?: ReadonlySet<string>): RuleError[] {
  const { rule, legacy } = parseRule(text);
  if (legacy) return ['legacy'];
  if (!rule) return [];
  const out: RuleError[] = [];
  if (rule.method === 'tasks') {
    if (!rule.tasks.length) out.push('no_tasks');
    if (known && rule.tasks.some((c) => !known.has(c))) out.push('unknown_task');
    if (rule.plan && !PLAN_RE.test(rule.plan)) out.push('bad_plan');
  }
  if (rule.method === 'register' && !rule.register.trim()) out.push('no_register');
  return out;
}
