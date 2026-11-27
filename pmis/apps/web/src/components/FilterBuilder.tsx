import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChoiceList } from './ChoiceList';
import { type FilterCondition, type FilterField, type FilterOperator, type FilterSubGroup, type FilterTree, type FilterValue } from '@/api/views';
import { DateInput } from '@/components/DateInput';

/**
 * F3 (contract 0.15.31): the AND/OR filter builder of a list screen. Groups are combined with AND or OR, two levels at most (the root group
 * and its groups). The fields, their operators and the limits come from the server (GET /saved-views/filter-fields), which leaves out the
 * fields the caller may not see. The tree is sent as JSON in the `filter` parameter and compiled by the server; this component never builds a
 * query. Since the unified filter (2026-11-22) this file keeps the AND/OR editor (FilterTreeEditor), opened from "Advanced (AND/OR)" in components/UnifiedFilter.tsx, and the chip text helpers.
 */
export type Item = FilterCondition | FilterSubGroup;
type Op = 'and' | 'or';
export const isGroup = (x: Item): x is FilterSubGroup => Array.isArray((x as FilterSubGroup).items);
const LIMITS = { items: 20, groups: 10, conditions: 50 };
const NO_VALUE: readonly string[] = ['empty', 'not_empty'];
const MULTI: readonly string[] = ['in', 'not_in'];
export const countConditions = (t: FilterTree) => t.items.reduce((n, it) => n + (isGroup(it) ? it.items.length : 1), 0);
const countGroups = (t: FilterTree) => t.items.filter(isGroup).length;

export const label = (f: FilterField | undefined, lang: string, key: string) => (f ? (lang === 'ar' && f.label_ar) || f.label_en : key);
export const optLabel = (f: FilterField | undefined, v: string, lang: string) => {
  const o = f?.options?.find((x) => x.value === v);
  return o ? (lang === 'ar' && o.label_ar) || o.label_en : v;
};

/** The default value of a new operator on a field. */
function defaultValue(f: FilterField, op: FilterOperator): FilterCondition['value'] {
  if (NO_VALUE.includes(op)) return undefined;
  if (MULTI.includes(op)) return f.options?.[0] ? [f.options[0].value] : [];
  if (op === 'between') return f.type === 'date' ? ['', ''] : [0, 0];
  if (op === 'in_last_days' || op === 'in_next_days') return 7;
  if (f.type === 'bool') return true;
  if (f.type === 'number') return 0;
  if (f.type === 'enum') return f.options?.[0]?.value ?? '';
  if (f.type === 'date') return { rel: 'today', offset: 0 };
  return '';
}
const newCondition = (f: FilterField): FilterCondition => ({ field: f.key, operator: f.operators[0] as FilterOperator, value: defaultValue(f, f.operators[0] as FilterOperator) });

/** One value as text for the chips. */
function valueText(v: FilterValue | undefined, f: FilterField | undefined, t: TFunction, lang: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') {
    const off = v.offset ?? 0;
    return off === 0 ? t('filterBuilder.today') : t('filterBuilder.today_offset', { count: off });
  }
  if (typeof v === 'boolean') return v ? t('filterBuilder.yes') : t('filterBuilder.no');
  return optLabel(f, String(v), lang);
}
export function conditionText(c: FilterCondition, fields: FilterField[], t: TFunction, lang: string): string {
  const f = fields.find((x) => x.key === c.field);
  const op = t(`filterBuilder.op.${c.operator}`);
  if (NO_VALUE.includes(c.operator)) return `${label(f, lang, c.field)} ${op}`;
  const v = Array.isArray(c.value) ? c.value.map((x) => valueText(x, f, t, lang)).join(c.operator === 'between' ? ` ${t('filterBuilder.and_word')} ` : ', ')
    : (c.operator === 'in_last_days' || c.operator === 'in_next_days') ? t('filterBuilder.days', { count: Number(c.value) }) : valueText(c.value as FilterValue, f, t, lang);
  return `${label(f, lang, c.field)} ${op} ${v}`;
}

function OpToggle({ value, onChange, id }: { value: Op; onChange: (o: Op) => void; id: string }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t('filterBuilder.match')} className="inline-flex overflow-hidden rounded border border-line" data-testid={`${id}-op`}>
      {(['and', 'or'] as const).map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} data-testid={`${id}-op-${o}`}
          className={`px-3 py-1 text-xs font-semibold ${value === o ? 'bg-accent text-accentInk' : 'bg-card text-ink'}`}
          onClick={() => onChange(o)}
          onKeyDown={(e) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); onChange(value === 'and' ? 'or' : 'and'); } }}>
          {t(`filterBuilder.${o}`)}
        </button>
      ))}
    </div>
  );
}

function ValueEditor({ c, f, onChange, id, screen }: { c: FilterCondition; f: FilterField; onChange: (v: FilterCondition['value']) => void; id: string; screen?: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const op = c.operator;
  if (NO_VALUE.includes(op)) return null;
  const aria = t('filterBuilder.value');
  if (f.type === 'enum' && f.options && f.truncated && screen) {
    // the list of values was cut by the server: the same checklist as the unified filter, which searches the server as the user types (0.15.49)
    const multi = MULTI.includes(op);
    const sel = multi ? (Array.isArray(c.value) ? c.value.map(String) : []) : c.value === undefined || c.value === '' ? [] : [String(c.value)];
    return (
      <div className="w-64" data-testid={`${id}-value`}>
        <ChoiceList idp={`${id}-choice`} single={!multi} truncated options={f.options.map((o) => ({ value: o.value, label: optLabel(f, o.value, lang) }))} selected={sel}
          search={{ screen, field: f.key, lang }}
          onToggle={(v) => onChange(multi ? (sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]) : v)} />
      </div>
    );
  }
  if (f.type === 'enum' && f.options) {
    if (MULTI.includes(op)) {
      const sel = Array.isArray(c.value) ? c.value.map(String) : [];
      return (
        <select multiple className="input min-h-16 w-48" aria-label={aria} data-testid={`${id}-value`} value={sel}
          onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}>
          {f.options.map((o) => <option key={o.value} value={o.value}>{optLabel(f, o.value, lang)}</option>)}
        </select>
      );
    }
    return (
      <select className="input w-44" aria-label={aria} data-testid={`${id}-value`} value={String(c.value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {f.options.map((o) => <option key={o.value} value={o.value}>{optLabel(f, o.value, lang)}</option>)}
      </select>
    );
  }
  if (f.type === 'bool') {
    return (
      <select className="input w-28" aria-label={aria} data-testid={`${id}-value`} value={String(c.value ?? true)} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">{t('filterBuilder.yes')}</option>
        <option value="false">{t('filterBuilder.no')}</option>
      </select>
    );
  }
  if (op === 'in_last_days' || op === 'in_next_days') {
    return <input type="number" min={0} max={3650} className="input w-24" aria-label={t('filterBuilder.days_label')} data-testid={`${id}-value`} value={Number(c.value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} />;
  }
  if (f.type === 'date') {
    const one = (v: FilterValue | undefined, set: (x: FilterValue) => void, sub: string) => {
      const rel = !!v && typeof v === 'object';
      return (
        <span className="inline-flex items-center gap-1">
          <select className="input w-auto" aria-label={t('filterBuilder.date_kind')} data-testid={`${id}-${sub}-kind`} value={rel ? 'rel' : 'fixed'}
            onChange={(e) => set(e.target.value === 'rel' ? { rel: 'today', offset: 0 } : '')}>
            <option value="fixed">{t('filterBuilder.fixed_date')}</option>
            <option value="rel">{t('filterBuilder.relative_date')}</option>
          </select>
          {rel
            ? <input type="number" min={-3650} max={3650} className="input w-20" aria-label={t('filterBuilder.offset_label')} data-testid={`${id}-${sub}-offset`}
                value={(v as { offset?: number }).offset ?? 0} onChange={(e) => set({ rel: 'today', offset: Number(e.target.value) })} />
            : <DateInput className="input w-40" aria-label={aria} data-testid={`${id}-${sub}`} value={typeof v === 'string' ? v : ''} onChange={(e) => set(e.target.value)} />}
        </span>
      );
    };
    if (op === 'between') {
      const pair = (Array.isArray(c.value) ? c.value : ['', '']) as FilterValue[];
      return <span className="inline-flex flex-wrap items-center gap-1">{one(pair[0], (x) => onChange([x, pair[1] ?? '']), 'from')}<span className="text-mute">{t('filterBuilder.and_word')}</span>{one(pair[1], (x) => onChange([pair[0] ?? '', x]), 'to')}</span>;
    }
    return one(c.value as FilterValue, (x) => onChange(x), 'value');
  }
  if (f.type === 'number') {
    if (op === 'between') {
      const pair = (Array.isArray(c.value) ? c.value : [0, 0]) as number[];
      return (
        <span className="inline-flex items-center gap-1">
          <input type="number" className="input w-24" aria-label={t('filterBuilder.from')} data-testid={`${id}-from`} value={pair[0] ?? 0} onChange={(e) => onChange([Number(e.target.value), pair[1] ?? 0])} />
          <span className="text-mute">{t('filterBuilder.and_word')}</span>
          <input type="number" className="input w-24" aria-label={t('filterBuilder.to')} data-testid={`${id}-to`} value={pair[1] ?? 0} onChange={(e) => onChange([pair[0] ?? 0, Number(e.target.value)])} />
        </span>
      );
    }
    return <input type="number" className="input w-28" aria-label={aria} data-testid={`${id}-value`} value={Number(c.value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} />;
  }
  if (MULTI.includes(op)) {
    const text = Array.isArray(c.value) ? c.value.join(', ') : '';
    return <input className="input w-48" aria-label={t('filterBuilder.values_hint')} placeholder={t('filterBuilder.values_hint')} data-testid={`${id}-value`} maxLength={4000} defaultValue={text}
      onBlur={(e) => onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 100))} />;
  }
  return <input className="input w-44" aria-label={aria} data-testid={`${id}-value`} maxLength={200} value={String(c.value ?? '')} onChange={(e) => onChange(e.target.value)} />;
}

function ConditionRow({ c, fields, onChange, onRemove, id, screen }: { c: FilterCondition; fields: FilterField[]; onChange: (c: FilterCondition) => void; onRemove: () => void; id: string; screen?: string }) {
  const { t, i18n } = useTranslation();
  const f = fields.find((x) => x.key === c.field);
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid={id}>
      <select className="input w-48" aria-label={t('filterBuilder.field')} data-testid={`${id}-field`} value={c.field}
        onChange={(e) => { const nf = fields.find((x) => x.key === e.target.value); if (nf) onChange(newCondition(nf)); }}>
        {!f && <option value={c.field}>{c.field}</option>}
        {fields.map((x) => <option key={x.key} value={x.key}>{label(x, i18n.language, x.key)}</option>)}
      </select>
      {f && (
        <select className="input w-40" aria-label={t('filterBuilder.operator')} data-testid={`${id}-operator`} value={c.operator}
          onChange={(e) => { const op = e.target.value as FilterOperator; onChange({ field: c.field, operator: op, value: defaultValue(f, op) }); }}>
          {f.operators.map((o) => <option key={o} value={o}>{t(`filterBuilder.op.${o}`)}</option>)}
        </select>
      )}
      {f && <ValueEditor c={c} f={f} id={id} screen={screen} onChange={(value) => onChange({ ...c, value })} />}
      <button type="button" className="btn px-2" aria-label={t('filterBuilder.remove_condition')} title={t('filterBuilder.remove_condition')} data-testid={`${id}-remove`} onClick={onRemove}><Trash2 size={14} aria-hidden /></button>
    </li>
  );
}

/** The builder itself (the draft tree); exported for the dialog and the tests. */
/** `screen` (the screen key of the filter fields) switches a truncated enum field to the server value search; without it the plain select is used. */
export function FilterTreeEditor({ tree, fields, onChange, screen }: { tree: FilterTree; fields: FilterField[]; onChange: (t: FilterTree) => void; screen?: string }) {
  const { t } = useTranslation();
  const conds = countConditions(tree), groups = countGroups(tree);
  const fullRoot = tree.items.length >= LIMITS.items, fullConds = conds >= LIMITS.conditions;
  const first = fields[0];
  const setItem = (i: number, it: Item) => onChange({ ...tree, items: tree.items.map((x, j) => (j === i ? it : x)) });
  const dropItem = (i: number) => onChange({ ...tree, items: tree.items.filter((_, j) => j !== i) });
  return (
    <div className="space-y-3" data-testid="filter-tree">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{t('filterBuilder.match_prefix')}</span>
        <OpToggle id="filter-root" value={tree.op} onChange={(op) => onChange({ ...tree, op })} />
        <span className="text-mute">{t('filterBuilder.match_suffix')}</span>
      </div>
      {tree.items.length === 0 && <p className="text-sm text-mute" data-testid="filter-empty">{t('filterBuilder.empty')}</p>}
      <ol className="space-y-2">
        {tree.items.map((it, i) => isGroup(it) ? (
          <li key={i} className="space-y-2 rounded border border-line p-2 ps-3" data-testid={`filter-group-${i}`}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{t('filterBuilder.group')}</span>
              <OpToggle id={`filter-group-${i}`} value={it.op} onChange={(op) => setItem(i, { ...it, op })} />
              <button type="button" className="btn ms-auto px-2" aria-label={t('filterBuilder.remove_group')} title={t('filterBuilder.remove_group')} data-testid={`filter-group-${i}-remove`} onClick={() => dropItem(i)}><Trash2 size={14} aria-hidden /></button>
            </div>
            <ol className="space-y-2">
              {it.items.map((c, j) => (
                <ConditionRow key={j} id={`filter-group-${i}-cond-${j}`} c={c} fields={fields} screen={screen}
                  onChange={(nc) => setItem(i, { ...it, items: it.items.map((x, k) => (k === j ? nc : x)) })}
                  onRemove={() => { const items = it.items.filter((_, k) => k !== j); if (items.length) setItem(i, { ...it, items }); else dropItem(i); }} />
              ))}
            </ol>
            <button type="button" className="btn text-xs" data-testid={`filter-group-${i}-add`} disabled={!first || it.items.length >= LIMITS.items || fullConds}
              onClick={() => first && setItem(i, { ...it, items: [...it.items, newCondition(first)] })}><Plus size={12} aria-hidden /> {t('filterBuilder.add_condition')}</button>
          </li>
        ) : (
          <ConditionRow key={i} id={`filter-cond-${i}`} c={it} fields={fields} screen={screen} onChange={(nc) => setItem(i, nc)} onRemove={() => dropItem(i)} />
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" data-testid="filter-add-condition" disabled={!first || fullRoot || fullConds}
          onClick={() => first && onChange({ ...tree, items: [...tree.items, newCondition(first)] })}><Plus size={14} aria-hidden /> {t('filterBuilder.add_condition')}</button>
        <button type="button" className="btn" data-testid="filter-add-group" disabled={!first || fullRoot || fullConds || groups >= LIMITS.groups}
          onClick={() => first && onChange({ ...tree, items: [...tree.items, { op: tree.op === 'and' ? 'or' : 'and', items: [newCondition(first)] }] })}><Plus size={14} aria-hidden /> {t('filterBuilder.add_group')}</button>
      </div>
      {(fullRoot || fullConds || groups >= LIMITS.groups) && <p className="text-xs text-mute" data-testid="filter-limit">{t('filterBuilder.limit', { items: LIMITS.items, groups: LIMITS.groups, conditions: LIMITS.conditions })}</p>}
    </div>
  );
}
