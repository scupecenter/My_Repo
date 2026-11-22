import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GateCondition } from '@/api/workflowEditor';
import { dateRefString, parseDateRef, SITE_DATES, TASK_DATES, type M, type P } from './model';

const TYPES = ['task', 'milestone', 'permit', 'date_field', 'stop_work_blocks'] as const;

/** The reference of a date condition, built from choices so that a wrong string cannot be typed: a task date, a date of the site, or a date custom field of the site. */
function DateRefInput({ value, onChange, tasks, prefix }: { value: string | undefined; onChange: (ref: string) => void; tasks: P[]; prefix: string }) {
  const { t } = useTranslation();
  const d = parseDateRef(value);
  const kind = d.kind;
  const sel = 'input';
  return (
    <span className="flex flex-wrap items-center gap-1">
      <select className={sel} aria-label={t('wfe.cond.date_kind')} data-testid={`${prefix}-dkind`} value={kind}
        onChange={(e) => onChange(dateRefString(e.target.value === 'task' ? { kind: 'task', task: tasks[0]?.task_code ?? '', field: 'actual_date' } : e.target.value === 'custom' ? { kind: 'custom', code: '' } : { kind: 'site', field: 'rf_survey_date' }))}>
        <option value="task">{t('wfe.cond.kind_task')}</option><option value="site">{t('wfe.cond.kind_site')}</option><option value="custom">{t('wfe.cond.kind_custom')}</option>
      </select>
      {d.kind === 'task' && <>
        <select className={sel} aria-label={t('wfe.cond.task')} data-testid={`${prefix}-dtask`} value={d.task} onChange={(e) => onChange(dateRefString({ ...d, task: e.target.value }))}>
          {tasks.map((p) => <option key={p.task_code} value={p.task_code}>{p.task_code}</option>)}
        </select>
        <select className={sel} aria-label={t('wfe.cond.field')} data-testid={`${prefix}-dfield`} value={d.field} onChange={(e) => onChange(dateRefString({ ...d, field: e.target.value }))}>
          {TASK_DATES.map((f) => <option key={f} value={f}>{t(`wfe.cond.f_${f}`)}</option>)}
        </select>
      </>}
      {d.kind === 'site' && (
        <select className={sel} aria-label={t('wfe.cond.field')} data-testid={`${prefix}-dfield`} value={d.field} onChange={(e) => onChange(dateRefString({ kind: 'site', field: e.target.value }))}>
          {SITE_DATES.map((f) => <option key={f} value={f}>{t(`wfe.cond.f_${f}`)}</option>)}
        </select>
      )}
      {d.kind === 'custom' && <input className={`${sel} w-32`} dir="ltr" aria-label={t('wfe.cond.custom_code')} placeholder="field_code" data-testid={`${prefix}-dcustom`} value={d.code} onChange={(e) => onChange(dateRefString({ kind: 'custom', code: e.target.value.toLowerCase() }))} />}
    </span>
  );
}

/** A fresh condition of a type, with the first valid reference. */
export function newCondition(type: string, tasks: P[], milestones: M[]): GateCondition {
  const base: GateCondition = { type };
  if (type === 'task') base.ref = tasks[0]?.task_code ?? '';
  if (type === 'milestone') base.ref = milestones[0]?.code ?? '';
  if (type === 'date_field') { base.ref = 'site.rf_survey_date'; base.offset_wd = 0; }
  if (type === 'permit') base.accept_na = true;
  return base;
}

/**
 * The conditions of a gate: a task approved, a milestone reached, a permit valid, a date of the site plus an offset in working days, or "no stop work".
 * References are chosen from the tasks and milestones of the version; a date condition is built from choices (0096).
 */
export function ConditionsEditor({ value, onChange, prefix, tasks, milestones, permits, quickAdd }: { value: GateCondition[]; onChange: (v: GateCondition[]) => void; prefix: string; tasks: P[]; milestones: M[]; permits: string[]; quickAdd?: boolean }) {
  const { t } = useTranslation();
  const set = (i: number, patch: Partial<GateCondition>) => onChange(value.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const setType = (i: number, type: string) => onChange(value.map((c, k) => (k === i ? newCondition(type, tasks, milestones) : c)));
  return (
    <div className="space-y-2" data-testid={`${prefix}-conditions`}>
      <p className="text-xs font-semibold">{t('wfe.conditions')}</p>
      {value.length === 0 && <p className="text-xs text-mute">{t('wfe.cond.none')}</p>}
      {value.map((c, i) => (
        <div key={i} className={`flex flex-wrap items-center gap-2 rounded-md border border-line p-2 ${quickAdd ? '[&_.input]:min-h-11 [&_.input]:w-auto' : ''}`} data-testid={`${prefix}-cond-${i}`}>
          <select className="input" aria-label={t('wfe.condition_type')} data-testid={`${prefix}-ctype-${i}`} value={c.type} onChange={(e) => setType(i, e.target.value)}>
            {TYPES.map((x) => <option key={x} value={x}>{t(`wfe.cond.type_${x}`)}</option>)}
          </select>
          {c.type === 'task' && (
            <select className="input" aria-label={t('wfe.condition_ref')} data-testid={`${prefix}-cref-${i}`} value={c.ref ?? ''} onChange={(e) => set(i, { ref: e.target.value })}>
              {tasks.map((p) => <option key={p.task_code} value={p.task_code}>{p.task_code} {p.name_en}</option>)}
            </select>
          )}
          {c.type === 'milestone' && (
            <select className="input" aria-label={t('wfe.condition_ref')} data-testid={`${prefix}-cref-${i}`} value={c.ref ?? ''} onChange={(e) => set(i, { ref: e.target.value })}>
              {milestones.map((m) => <option key={m.code} value={m.code}>{m.code} {m.name_en}</option>)}
            </select>
          )}
          {(c.type === 'permit' || c.type === 'stop_work_blocks') && (
            <>
              <input className="input w-40" dir="ltr" list={`${prefix}-permits`} aria-label={t('wfe.condition_ref')} data-testid={`${prefix}-cref-${i}`} value={c.ref ?? ''} onChange={(e) => set(i, { ref: e.target.value })} />
              <datalist id={`${prefix}-permits`}>{permits.map((x) => <option key={x} value={x} />)}</datalist>
            </>
          )}
          {c.type === 'date_field' && (
            <>
              <DateRefInput value={c.ref} onChange={(ref) => set(i, { ref })} tasks={tasks} prefix={`${prefix}-${i}`} />
              <label className="flex items-center gap-1 text-xs">{t('wfe.cond.offset')}
                <input type="number" min={-365} max={365} step={1} className="input w-20" dir="ltr" data-testid={`${prefix}-offset-${i}`} value={c.offset_wd ?? 0}
                  onChange={(e) => set(i, { offset_wd: Math.max(-365, Math.min(365, Math.trunc(Number(e.target.value) || 0))) })} /></label>
            </>
          )}
          {c.type !== 'stop_work_blocks' && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={c.accept_na ?? false} onChange={(e) => set(i, { accept_na: e.target.checked })} />{t('wfe.accept_na')}</label>}
          <button type="button" className={`btn ${quickAdd ? 'min-h-11 min-w-11' : ''}`} aria-label={t('common.remove')} onClick={() => onChange(value.filter((_, k) => k !== i))}><Trash2 size={14} aria-hidden /></button>
        </div>
      ))}
      {quickAdd ? (
        <div className="flex flex-wrap gap-2">
          {([['task', 'quick_task'], ['milestone', 'quick_milestone'], ['permit', 'quick_permit'], ['date_field', 'quick_date']] as const).map(([type, k]) => (
            <button key={type} type="button" className="btn min-h-11" data-testid={`${prefix}-add-${type}`} onClick={() => onChange([...value, newCondition(type, tasks, milestones)])}><Plus size={14} aria-hidden /> {t(`wfe.cond.${k}`)}</button>
          ))}
        </div>
      ) : (
      <button type="button" className="btn" data-testid={`${prefix}-add-condition`} onClick={() => onChange([...value, { type: 'task', ref: tasks[0]?.task_code ?? '' }])}><Plus size={14} aria-hidden /> {t('wfe.add_condition')}</button>
      )}
    </div>
  );
}

/** One line for a condition, for the gate card and the detail panel. */
export function conditionLabel(c: GateCondition, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (c.type === 'stop_work_blocks') return t('wfe.cond.line_stop', { ref: c.ref ?? '' });
  if (c.type === 'date_field') {
    const n = c.offset_wd ?? 0;
    return t('wfe.cond.line_date', { ref: c.ref ?? '', offset: n > 0 ? `+${n}` : String(n) });
  }
  return t(`wfe.cond.line_${c.type}`, { ref: c.ref ?? '' });
}
