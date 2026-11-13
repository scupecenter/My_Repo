import { ShieldAlert, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OVERRIDE_DATE_FIELDS, useCreateTaskOverride, useRevertOverride, type DateField } from '@/api/adminEdit';
import type { TaskDetail } from '@/api/types';
import { taskErrorMessage } from '@/lib/taskErrors';
import { useToast } from './Toast';

/**
 * Owner decision 2026-11-12 (2), contract 0.15.6: a System Admin sets any date of a task at once ("Edit date"), reason and step-up required, flagged "Admin override".
 * Every override can be reverted while the date still holds what it set. Shown only when the task detail says `can_override`, or when it already carries overrides.
 */
export function AdminTaskOverride({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const create = useCreateTaskOverride(task);
  const revert = useRevertOverride(task.site_id, task.id);
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<DateField>('planned_date');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [rev, setRev] = useState<{ id: string; reason: string } | null>(null);
  const items = task.overrides ?? [];
  if (!task.can_override && items.length === 0) return null;
  const fail = (e: unknown) => { const m = taskErrorMessage(t as never, e); if (m) toast(m, 'err'); };
  const current = (f: DateField) => (task as unknown as Record<string, string | null | undefined>)[f] ?? '';
  const pick = (f: DateField) => { setField(f); setDate(current(f) ?? ''); };
  const apply = () => create.mutate({ date_field: field, new_date: date || null, reason: reason.trim() }, {
    onSuccess: () => { toast(t('adminOverride.applied')); setOpen(false); setReason(''); },
    onError: fail,
  });
  const undo = () => rev && revert.mutate({ id: rev.id, reason: rev.reason.trim() }, {
    onSuccess: () => { toast(t('adminOverride.reverted')); setRev(null); },
    onError: fail,
  });
  const show = (o: Record<string, unknown> | undefined) => Object.entries(o ?? {}).map(([k, v]) => `${t(`adminOverride.field.${k}`, { defaultValue: k })}: ${v == null || v === '' ? t('adminOverride.none') : String(v)}`).join(', ');

  return (
    <section aria-label={t('adminOverride.title')} className="space-y-2 rounded-md border border-line p-3 text-sm" data-testid="admin-override">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{t('adminOverride.title')}</h3>
        {task.can_override && !open && <button className="btn ms-auto" data-testid="admin-override-open" onClick={() => { pick(field); setOpen(true); }}>{t('adminOverride.edit_date')}</button>}
      </div>
      {open && (
        <div className="space-y-2" data-testid="admin-override-form">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1"><span className="text-mute">{t('adminOverride.which')}</span>
              <select className="input" data-testid="admin-override-field" value={field} onChange={(e) => pick(e.target.value as DateField)}>
                {OVERRIDE_DATE_FIELDS.map((f) => <option key={f} value={f}>{t(`adminOverride.field.${f}`)}</option>)}
              </select></label>
            <label className="flex flex-col gap-1"><span className="text-mute">{t('adminOverride.new_date')}</span>
              <input type="date" className="input mono" data-testid="admin-override-date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          </div>
          <input className="input w-full" aria-label={t('adminOverride.reason')} placeholder={t('adminOverride.reason')} data-testid="admin-override-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <p className="text-xs text-mute">{t('adminOverride.note')}</p>
          <div className="flex gap-2">
            <button className="btn btn-primary" data-testid="admin-override-apply" disabled={reason.trim().length < 3 || (date || null) === (current(field) || null) || create.isPending} onClick={apply}>{t('adminOverride.apply')}</button>
            <button className="btn" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
      <ul className="space-y-1" data-testid="admin-override-list">
        {items.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center gap-2" data-testid={`admin-override-${o.id}`} data-reverted={o.reverted_at ? 'true' : 'false'}>
            <span className="chip bg-waitBg text-waitInk"><ShieldAlert size={12} className="me-1" aria-hidden />{t('override.badge')}</span>
            <span>{show(o.before)} {'->'} {show(o.after)}</span>
            <span className="text-mute">{o.acted_by?.display_name} · {o.reason}</span>
            {o.reverted_at && <span className="chip bg-lockBg text-lockInk">{t('adminOverride.was_reverted')}</span>}
            {o.revertible && task.can_override && <button className="btn px-2 py-0.5 text-xs" data-testid={`admin-override-revert-${o.id}`} onClick={() => setRev({ id: o.id, reason: '' })}><Undo2 size={12} />{t('adminOverride.revert')}</button>}
          </li>
        ))}
      </ul>
      {rev && (
        <div className="flex flex-wrap items-center gap-2" data-testid="admin-override-revert-form">
          <input className="input min-w-[16rem] flex-1" aria-label={t('adminOverride.reason')} placeholder={t('adminOverride.reason')} data-testid="admin-override-revert-reason" value={rev.reason} onChange={(e) => setRev({ ...rev, reason: e.target.value })} />
          <button className="btn btn-primary" data-testid="admin-override-revert-send" disabled={rev.reason.trim().length < 3 || revert.isPending} onClick={undo}>{t('adminOverride.revert')}</button>
          <button className="btn" onClick={() => setRev(null)}>{t('common.cancel')}</button>
        </div>
      )}
    </section>
  );
}
