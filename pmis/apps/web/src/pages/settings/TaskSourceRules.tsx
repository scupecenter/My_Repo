import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveTaskSourceRules, useTaskSourceRules, type TaskSourceRule } from '@/api/taskSourceRules';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { UnsavedGuard } from '@/lib/unsavedGuard';

/**
 * Settings > Registers > Task source rules (automation item 4, migration 0770). A rule says: a record of this register that matches the condition (for example Order Status
 * is Delivered) is the source of this task and gives it the date of this field. The workflow is the one that already exists (Q43): the record is linked to the task at its
 * submission only while the task is open, and the final approval gives the task its date and approves it. An approved task is never reopened or re-dated. A rule is hidden,
 * never deleted. Nothing new fires until a rule is added here.
 */
export function TaskSourceRules() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useTaskSourceRules(), save = useSaveTaskSourceRules();
  const [rows, setRows] = useState<TaskSourceRule[] | null>(null);
  const [open, setOpen] = useState(false);
  const [n, setN] = useState({ register_key: '', task_code: '', date_field: '', cond_field: '', cond_values: '' });
  if (!q.data) return <section className="card p-4" data-testid="page-task-source-rules"><QueryFallback queries={[q]} testid="tsr-loading" /></section>;
  const ar = i18n.language === 'ar';
  const list = rows ?? q.data.rows;
  const can = q.data.can_edit;
  const errs = fieldErrors(save.error);
  const regName = (k: string) => { const r = q.data.registers.find((x) => x.register_key === k); return r ? (ar && r.name_ar) || r.name_en : k; };
  const taskName = (c: string) => { const x = q.data.tasks.find((y) => y.code === c); return x ? `${c} ${(ar && x.name_ar) || x.name_en}` : c; };
  const fieldsOf = (k: string) => q.data.registers.find((x) => x.register_key === k)?.fields ?? [];
  const fieldName = (k: string, c: string) => { const f = fieldsOf(k).find((x) => x.code === c); return f ? (ar && f.label_ar) || f.label_en : c; };
  const key = (x: { register_key: string; task_code: string }) => `${x.register_key}-${x.task_code}`;
  const set = (x: TaskSourceRule, p: Partial<TaskSourceRule>) => setRows(list.map((y) => (key(y) === key(x) ? { ...y, ...p } : y)));
  const body = (reason: string) => ({ version: q.data.version, body: { reason, rows: list } });
  const condText = (x: TaskSourceRule) => [...Object.entries(x.data_eq).map(([f, v]) => `${fieldName(x.register_key, f)} = ${v}`), ...Object.entries(x.data_in).map(([f, v]) => `${fieldName(x.register_key, f)}: ${v.join(', ')}`)].join('; ') || t('taskSrc.always');
  const dates = fieldsOf(n.register_key).filter((f) => f.field_type === 'date');
  const condFields = fieldsOf(n.register_key).filter((f) => f.field_type === 'list' || f.field_type === 'yes_no' || f.field_type === 'text');
  const condOpts = condFields.find((f) => f.code === n.cond_field)?.options ?? null;
  const vals = n.cond_values.split(',').map((v) => v.trim()).filter(Boolean);
  const addable = n.register_key && n.task_code && n.date_field && (!n.cond_field || vals.length > 0) && !list.some((x) => key(x) === key(n));
  return (
    <section className="card space-y-3 p-4" data-testid="page-task-source-rules">
      <h2 className="font-bold">{t('taskSrc.title')}</h2>
      <p className="text-sm text-mute">{t('taskSrc.note')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr><th className="text-start">{t('taskSrc.register')}</th><th className="text-start">{t('taskSrc.task')}</th><th className="text-start">{t('taskSrc.when')}</th><th className="text-start">{t('taskSrc.date_field')}</th><th className="text-start">{t('companyDocs.shown')}</th></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={key(x)} data-testid={`tsr-row-${key(x)}`} className={x.is_active ? '' : 'opacity-60'}>
                <td>{regName(x.register_key)}</td>
                <td>{taskName(x.task_code)}</td>
                <td className="text-mute">{condText(x)}</td>
                <td>
                  <select className="input" disabled={!can} data-testid={`tsr-date-${key(x)}`} value={x.date_field} onChange={(e) => set(x, { date_field: e.target.value })}>
                    {fieldsOf(x.register_key).filter((f) => f.field_type === 'date' || f.code === x.date_field).map((f) => <option key={f.code} value={f.code}>{(ar && f.label_ar) || f.label_en}</option>)}
                  </select>
                </td>
                <td><input type="checkbox" disabled={!can} data-testid={`tsr-active-${key(x)}`} checked={x.is_active} onChange={(e) => set(x, { is_active: e.target.checked })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {can && (
        <div className="flex flex-wrap items-end gap-2" role="group" aria-label={t('taskSrc.add_title')}>
          <label className="text-sm font-semibold">{t('taskSrc.register')}
            <select className="input mt-1 font-normal" data-testid="tsr-new-register" value={n.register_key} onChange={(e) => setN({ ...n, register_key: e.target.value, date_field: '', cond_field: '', cond_values: '' })}>
              <option value="">{t('taskSrc.pick')}</option>
              {q.data.registers.map((r) => <option key={r.register_key} value={r.register_key}>{(ar && r.name_ar) || r.name_en}</option>)}
            </select></label>
          <label className="text-sm font-semibold">{t('taskSrc.task')}
            <select className="input mt-1 font-normal" data-testid="tsr-new-task" value={n.task_code} onChange={(e) => setN({ ...n, task_code: e.target.value })}>
              <option value="">{t('taskSrc.pick')}</option>
              {q.data.tasks.map((x) => <option key={x.code} value={x.code}>{x.code} {(ar && x.name_ar) || x.name_en}</option>)}
            </select></label>
          <label className="text-sm font-semibold">{t('taskSrc.date_field')}
            <select className="input mt-1 font-normal" data-testid="tsr-new-date" value={n.date_field} onChange={(e) => setN({ ...n, date_field: e.target.value })}>
              <option value="">{t('taskSrc.pick')}</option>
              {dates.map((f) => <option key={f.code} value={f.code}>{(ar && f.label_ar) || f.label_en}</option>)}
            </select></label>
          <label className="text-sm font-semibold">{t('taskSrc.cond_field')}
            <select className="input mt-1 font-normal" data-testid="tsr-new-cond" value={n.cond_field} onChange={(e) => setN({ ...n, cond_field: e.target.value, cond_values: '' })}>
              <option value="">{t('taskSrc.no_condition')}</option>
              {condFields.map((f) => <option key={f.code} value={f.code}>{(ar && f.label_ar) || f.label_en}</option>)}
            </select></label>
          {n.cond_field && (condOpts ? (
            <fieldset className="flex flex-wrap gap-2 text-sm" data-testid="tsr-new-values">
              {condOpts.map((o) => (
                <label key={o} className="flex items-center gap-1"><input type="checkbox" checked={vals.includes(o)}
                  onChange={(e) => setN({ ...n, cond_values: (e.target.checked ? [...vals, o] : vals.filter((v) => v !== o)).join(',') })} />{o}</label>
              ))}
            </fieldset>
          ) : (
            <label className="text-sm font-semibold">{t('taskSrc.values')}<input className="input mt-1 font-normal" data-testid="tsr-new-values" value={n.cond_values} onChange={(e) => setN({ ...n, cond_values: e.target.value })} /></label>
          ))}
          <button className="btn" data-testid="tsr-new-add" disabled={!addable}
            onClick={() => {
              setRows([...list, { register_key: n.register_key, task_code: n.task_code, date_field: n.date_field, data_eq: {}, data_in: n.cond_field ? { [n.cond_field]: vals } : {}, sort_order: 0, is_active: true }]);
              setN({ register_key: '', task_code: '', date_field: '', cond_field: '', cond_values: '' });
            }}>{t('companyDocs.add')}</button>
        </div>
      )}
      {Object.entries(errs).map(([p, c]) => <p key={p} role="alert" className="text-xs text-lateInk">{p}: {t(`fieldError.${c}`, { defaultValue: c })}</p>)}
      <p className="mono text-xs text-mute" data-testid="tsr-version">{t('scopeMatch.version', { version: q.data.version })}</p>
      <button className="btn btn-accent" data-testid="tsr-save" disabled={!can || !rows} onClick={() => setOpen(true)}>{t('common.save')}</button>
      <UnsavedGuard scope="settings" dirty={!!rows} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => save.mutate(body(reason), { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="tsr-dialog" title={t('taskSrc.title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate(body(reason), { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setRows(null); } })} />
      )}
    </section>
  );
}
