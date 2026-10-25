import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAbsences, useAlerts, useCreateAbsence, useDeleteAbsence, useReassign } from '@/api/admin';
import { useMe } from '@/api/hooks';
import type { Absence as AbsenceT, ReassignmentAlert, UserPickerItem } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { PeoplePicker } from '@/components/PeoplePicker';
import { PersonTag } from '@/components/PersonTag';
import { useToast } from '@/components/Toast';

const KINDS = ['annual', 'sick', 'emergency', 'other'] as const;
type Decision = 'reassign' | 'act_on_behalf' | 'keep';
type Scope = 'task' | 'site' | 'person';

function CoverDialog({ alert, decision, onClose }: { alert: ReassignmentAlert; decision: Decision; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const m = useReassign();
  const [scope, setScope] = useState<Scope>('task');
  const [to, setTo] = useState<UserPickerItem[]>([]);
  const from = alert.holder?.id;
  const hide = (a: ReassignmentAlert) => scope === 'task' ? a.task.id === alert.task.id : scope === 'site' ? a.task.site_id === alert.task.site_id && a.holder?.id === from : a.holder?.id === from;
  const req = (reason: string) => ({ scope, decision, reason, ...(scope === 'task' ? { task_id: alert.task.id } : { from_user_id: from, ...(scope === 'site' ? { site_id: alert.task.site_id } : {}) }), ...(decision === 'reassign' ? { to_user_id: to[0]?.id } : {}) }) as never;
  return (
    <FormDialog open onClose={onClose} testid="cover-dialog" title={t(`cover.decision_${decision}`)} disabled={decision === 'reassign' && !to.length} busy={m.isPending} error={m.isError ? errText(m.error, t) : null}
      submitLabel={t(`cover.do_${decision}`)} onSubmit={(reason) => m.mutate({ req: req(reason), hide }, { onSuccess: (r) => { toast(t('cover.done', { count: r.done.length })); onClose(); } })}>
      <fieldset data-testid="cover-scope"><legend className="text-sm font-semibold">{t('cover.scope')}</legend>
        <div className="mt-1 flex flex-col gap-1 text-sm">{(['task', 'site', 'person'] as const).map((s) => (
          <label key={s} className="flex items-center gap-2"><input type="radio" name="cover-scope" data-testid={`cover-scope-${s}`} checked={scope === s} onChange={() => setScope(s)} />{t(`cover.scope_${s}`)}</label>))}</div></fieldset>
      {decision === 'reassign' && <div><b className="text-sm">{t('cover.to')}</b><PeoplePicker id="cover-to" single value={to} onChange={setTo} eligible={{ from }} /><p className="mt-1 text-xs text-mute">{t('cover.eligible_only')}</p></div>}
      <p className="rounded-md bg-card2 p-2 text-sm text-mute" data-testid="cover-sla-note">{t('cover.sla_note')}</p>
    </FormDialog>
  );
}

function AlertList({ cause }: { cause: 'absent' | 'idle' }) {
  const { t, i18n } = useTranslation();
  const q = useAlerts(cause);
  const [act, setAct] = useState<null | { alert: ReassignmentAlert; decision: Decision }>(null);
  const items = q.data ?? [];
  return (
    <section className="card p-4" data-testid={`alerts-${cause}`}>
      <h2 className="mb-2 font-bold">{t(`cover.alerts_${cause}`)} <span className="chip bg-card2 text-mute" data-testid={`alerts-count-${cause}`}>{items.length}</span></h2>
      <ul className="divide-y divide-line">
        {items.map((a) => (
          <li key={a.task.id} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid={`alert-${a.task.id}`}>
            <span className="min-w-48 flex-1"><b className="mono">{a.task.site_code}</b> {a.task.task_code} · {(i18n.language === 'ar' && a.task.name_ar) || a.task.name_en}</span>
            {a.holder && <PersonTag name={a.holder.display_name} employeeId={a.holder.employee_id} />}
            {a.cause === 'absent' ? <span className="chip bg-lateBg text-lateInk">{t('cover.absent')}</span> : <span className="chip bg-waitBg text-waitInk">{t('cover.idle_days', { count: a.idle_working_days ?? 0 })}</span>}
            {(['keep', 'reassign', 'act_on_behalf'] as const).map((d) => <button key={d} className="btn" data-testid={`alert-${d}-${a.task.id}`} onClick={() => setAct({ alert: a, decision: d })}>{t(`cover.decision_${d}`)}</button>)}
          </li>
        ))}
        {q.isSuccess && !items.length && <li className="py-3 text-mute" data-testid={`alerts-empty-${cause}`}>{t('cover.none')}</li>}
      </ul>
      {act && <CoverDialog {...act} onClose={() => setAct(null)} />}
    </section>
  );
}

export function Absence() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true), list = useAbsences(), create = useCreateAbsence(), del = useDeleteAbsence();
  const lead = !!me.data?.is_system_admin || !!me.data?.effective.grants.some((g) => g.action === ('reassign' as string));
  const [kind, setKind] = useState<(typeof KINDS)[number]>('annual');
  const [who, setWho] = useState<UserPickerItem[]>([]);
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [note, setNote] = useState('');
  const bad = !from || !to || to < from;
  const submit = () => create.mutate({ kind, from_date: from, to_date: to, ...(who[0] ? { user_id: who[0].id } : {}), ...(note ? { note } : {}) }, {
    onSuccess: () => { toast(t('absence.saved')); setFrom(''); setTo(''); setNote(''); setWho([]); },
  });
  return (
    <div data-testid="page-absence" className="space-y-4">
      <div><h1 className="text-2xl font-bold">{t('absence.title')}</h1><p className="text-mute">{t('absence.subtitle')}</p></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-3 p-4" data-testid="absence-form">
          <h2 className="font-bold">{t('absence.record')}</h2>
          <label className="block text-sm font-semibold">{t('absence.kind')}
            <select className="input mt-1 font-normal" data-testid="absence-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {KINDS.filter((k) => lead || k === 'annual').map((k) => <option key={k} value={k}>{t(`absence.kind_${k}`)}</option>)}</select></label>
          {lead && <div><b className="text-sm">{t('absence.person')}</b><PeoplePicker id="absence-who" single value={who} onChange={setWho} /><p className="text-xs text-mute">{t('absence.person_hint')}</p></div>}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm font-semibold">{t('absence.from')}<input type="date" className="input mt-1 font-normal" data-testid="absence-from" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-sm font-semibold">{t('absence.to')}<input type="date" className="input mt-1 font-normal" data-testid="absence-to" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <label className="block text-sm font-semibold">{t('absence.note')}<input className="input mt-1 font-normal" data-testid="absence-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          {create.isError && <p role="alert" className="text-lateInk" data-testid="absence-error">{errText(create.error, t)}</p>}
          <button className="btn btn-accent" data-testid="absence-submit" disabled={bad || create.isPending} onClick={submit}>{t('absence.save')}</button>
        </section>
        <section className="card p-4">
          <h2 className="mb-2 font-bold">{t('absence.list')}</h2>
          <ul className="divide-y divide-line" data-testid="absence-list">
            {(list.data ?? []).map((a: AbsenceT) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid={`absence-${a.user.employee_id}`}>
                <PersonTag name={a.user.display_name} employeeId={a.user.employee_id} />
                <span className="chip bg-lateBg text-lateInk" data-testid={`absent-badge-${a.user.employee_id}`}>{t('cover.absent')} · {t(`absence.kind_${a.kind}`)}</span>
                <span className="mono text-xs">{a.from_date} → {a.to_date}</span>
                {!!a.open_task_count && <span className="text-mute">{t('absence.open_tasks', { count: a.open_task_count })}</span>}
                <span className="flex-1" />
                <button className="btn" aria-label={t('common.remove')} data-testid={`absence-delete-${a.user.employee_id}`} onClick={() => del.mutate(a, { onError: (e) => toast(errText(e, t), 'err') })}><Trash2 size={14} /></button>
              </li>
            ))}
            {list.isSuccess && !(list.data ?? []).length && <li className="py-3 text-mute">{t('absence.none')}</li>}
          </ul>
        </section>
      </div>
      {lead && <><AlertList cause="absent" /><AlertList cause="idle" /></>}
    </div>
  );
}
