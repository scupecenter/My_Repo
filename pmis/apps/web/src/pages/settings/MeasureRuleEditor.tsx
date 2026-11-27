import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStartEvents } from '@/api/settings';
import { EMPTY_RULE, parseRule, RULE_METHODS, ruleErrors, serializeRule, type Rule, type RuleMethod } from '@/lib/measureRule';

/**
 * The measure rule of one weight item as fields (Gap 1 of the Settings review): how the dashboard counts the item, which tasks of the workflow in force it
 * counts and which milestone plan it is measured against. It stores the same text the server reads, so nothing else changes; the old raw box is gone.
 */
export function MeasureRuleEditor({ code, value, onChange, disabled }: { code: string; value: string | null | undefined; onChange: (text: string | null) => void; disabled?: boolean }) {
  const { t, i18n } = useTranslation();
  const ev = useStartEvents();
  const [filter, setFilter] = useState('');
  const { rule, legacy } = parseRule(value);
  const known = useMemo(() => (ev.data ? new Set(ev.data.tasks.map((x) => x.code)) : undefined), [ev.data]);
  const errs = ruleErrors(value, known);
  const method: RuleMethod | 'auto_off' = rule ? rule.method : 'auto_off';
  const set = (patch: Partial<Rule>) => onChange(serializeRule({ ...(rule ?? EMPTY_RULE), ...patch }));
  const tasks = (ev.data?.tasks ?? []).filter((x) => !filter.trim() || `${x.code} ${x.name_en} ${x.name_ar ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const ar = i18n.language === 'ar';
  const milestones = ev.data?.milestones ?? [];
  const label = (k: string) => t(`wtSet.rule.${k}`);
  return (
    <div className="min-w-60 flex-1 space-y-1 rounded-md border border-line p-2" data-testid={`weights-item-rule-${code}`} role="group" aria-label={t('wtSet.measure')}>
      <select className="input" data-testid={`weights-item-method-${code}`} aria-label={label('method')} disabled={disabled} aria-invalid={errs.length > 0}
        value={method} onChange={(e) => (e.target.value === 'auto_off' ? onChange(null) : set({ method: e.target.value as RuleMethod }))}>
        <option value="auto_off">{label('m_off')}</option>
        {RULE_METHODS.map((m) => <option key={m} value={m}>{label(`m_${m}`)}</option>)}
      </select>
      {legacy && <p className="text-xs text-late" role="alert" data-testid={`weights-item-rule-legacy-${code}`}>{label('legacy')} <code className="mono">{value}</code></p>}
      {rule?.method === 'tasks' && (
        <>
          <input className="input py-1" type="search" aria-label={label('filter')} placeholder={label('filter')} value={filter} onChange={(e) => setFilter(e.target.value)} disabled={disabled} />
          <ul className="max-h-32 overflow-y-auto rounded-md border border-line text-sm" data-testid={`weights-item-tasks-${code}`}>
            {rule.tasks.filter((c) => known && !known.has(c)).map((c) => (
              <li key={c} className="flex items-center gap-2 px-2 py-1 text-late"><input type="checkbox" checked disabled={disabled} onChange={() => set({ tasks: rule.tasks.filter((x) => x !== c) })} aria-label={`${c}: ${label('unknown_task')}`} /><span className="mono">{c}</span><span>{label('unknown_task')}</span></li>
            ))}
            {tasks.map((x) => (
              <li key={x.code}>
                <label className="flex items-center gap-2 px-2 py-1 hover:bg-hover">
                  <input type="checkbox" checked={rule.tasks.includes(x.code)} disabled={disabled}
                    onChange={(e) => set({ tasks: e.target.checked ? [...rule.tasks, x.code] : rule.tasks.filter((c) => c !== x.code) })} />
                  <span className="mono">{x.code}</span><span className="truncate">{ar && x.name_ar ? x.name_ar : x.name_en}</span>
                </label>
              </li>
            ))}
          </ul>
          <label className="block text-xs font-semibold">{label('plan')}
            <select className="input mt-1 font-normal" data-testid={`weights-item-plan-${code}`} value={rule.plan} disabled={disabled} onChange={(e) => set({ plan: e.target.value })}>
              <option value="">{label('plan_none')}</option>
              {milestones.map((m) => <option key={m.code} value={m.code}>{m.code}</option>)}
            </select>
          </label>
        </>
      )}
      {rule?.method === 'register' && (
        <input className="input py-1" aria-label={label('register')} placeholder={label('register')} value={rule.register} disabled={disabled} onChange={(e) => set({ register: e.target.value })} />
      )}
      {rule && rule.method !== 'tasks' && (
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={rule.central} disabled={disabled} onChange={(e) => set({ central: e.target.checked })} />{label('central')}</label>
      )}
      {errs.filter((e) => e !== 'legacy').map((e) => <p key={e} className="text-xs text-late" role="alert" data-testid={`weights-item-rule-err-${code}-${e}`}>{label(e)}</p>)}
    </div>
  );
}
