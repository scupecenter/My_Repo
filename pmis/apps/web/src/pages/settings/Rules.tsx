import { Lock, Unlock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDlp, useFreeze, useIdle, useLiftFreeze, usePublishDlp, useSetIdle, useSlaRules, useWeightSets } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { weightIssues } from '@/lib/weights';
import { FieldErr } from './Calendar';

export const FREEZE_CONFIRM = 'structural-freeze';

export function SlaRules() {
  const { t } = useTranslation();
  const q = useSlaRules();
  return (
    <section className="card overflow-x-auto p-4" data-testid="page-sla">
      <h2 className="mb-1 font-bold">{t('rules.sla')}</h2>
      <p className="mb-3 text-sm text-mute">{t('rules.sla_note')}</p>
      <table className="w-full text-sm">
        <thead className="text-mute"><tr>{['task', 'min', 'max', 'start', 'effective', 'open'].map((k) => <th key={k} className="p-2 text-start">{t(`rules.col_${k}`)}</th>)}</tr></thead>
        <tbody data-testid="sla-list">
          {(q.data ?? []).map((r) => (
            <tr key={r.id} className="border-t border-line" data-testid={`sla-${r.task_code}`}>
              <td className="mono p-2">{r.task_code}</td><td className="p-2">{r.min_working_days}</td><td className="p-2">{r.max_working_days}</td><td className="p-2">{r.start_event}</td><td className="mono p-2 text-xs">{r.effective_from}</td><td className="p-2">{r.open_task_count ?? 0}</td>
            </tr>))}
        </tbody>
      </table>
    </section>
  );
}

export function WeightSets() {
  const { t } = useTranslation();
  const q = useWeightSets();
  return (
    <div className="space-y-4" data-testid="page-weights">
      <p className="text-sm text-mute">{t('rules.weights_note')}</p>
      {(q.data ?? []).map((w) => {
        const issues = weightIssues(w), top = issues.find((i) => i.level === 'activities');
        return (
          <section key={w.id} className="card p-4" data-testid={`weights-${w.code}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h2 className="me-auto font-bold">{t(`rules.set_${w.code}`)} <span className="mono text-xs text-mute">v{w.version}</span></h2>
              <span className={`chip ${w.status === 'published' ? 'bg-doneBg text-doneInk' : 'bg-waitBg text-waitInk'}`}>{t(`rules.status_${w.status}`)}</span>
              <span className={`chip ${issues.length ? 'bg-lateBg text-lateInk' : 'bg-doneBg text-doneInk'}`} data-testid={`weights-valid-${w.code}`}>{issues.length ? t('rules.invalid') : t('rules.valid')}</span>
              <button className="btn" data-testid={`weights-publish-${w.code}`} disabled title={issues.length ? t('rules.publish_blocked') : t('rules.publish_pending')}>{t('rules.publish')}</button>
            </div>
            <ul className="space-y-1 text-sm">
              {w.activities.map((a) => {
                const bad = issues.find((i) => i.activity === a.code);
                return (
                  <li key={a.code} data-testid={`weights-activity-${w.code}-${a.code}`}>
                    <div className="flex gap-2"><span className="flex-1">{a.name_en}</span><span className="mono">{a.weight}%</span></div>
                    {a.items.length > 0 && <ul className="ms-4 text-mute">{a.items.map((i) => <li key={i.code} className="flex gap-2"><span className="flex-1">{i.name_en}</span><span className="mono">{i.weight}%</span></li>)}</ul>}
                    {bad && <p role="alert" className="ms-4 text-xs text-lateInk" data-testid={`weights-error-${w.code}-${a.code}`}>{t('rules.sum_items', { sum: bad.sum })}</p>}
                  </li>);
              })}
            </ul>
            {top && <p role="alert" className="mt-2 text-sm font-semibold text-lateInk" data-testid={`weights-error-${w.code}`}>{t('rules.sum_activities', { sum: top.sum })}</p>}
          </section>);
      })}
    </div>
  );
}

export function Freeze() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useFreeze(), lift = useLiftFreeze();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const f = q.data;
  const errs = fieldErrors(lift.error);
  return (
    <section className="card space-y-3 p-4" data-testid="page-freeze">
      <h2 className="flex items-center gap-2 font-bold">{f?.active ? <Lock size={16} /> : <Unlock size={16} />}{t('rules.freeze')}</h2>
      <p data-testid="freeze-status" className="text-sm">{f?.lifted ? t('rules.freeze_lifted') : f?.active ? t('rules.freeze_active') : t('rules.freeze_inactive')}</p>
      {f?.starts_on && <p className="mono text-xs text-mute">{f.starts_on} → {f.ends_on}</p>}
      {f?.lifted && <p className="text-sm text-mute">{t('rules.lift_reason', { reason: f.lift_reason })}</p>}
      <p className="text-xs text-mute">{t('rules.freeze_note')}</p>
      {f && !f.lifted && <button className="btn btn-accent" data-testid="freeze-lift" onClick={() => { setTyped(''); setOpen(true); }}>{t('rules.lift')}</button>}
      {open && f && (
        <FormDialog open onClose={() => setOpen(false)} testid="freeze-dialog" title={t('rules.lift')} disabled={typed !== FREEZE_CONFIRM} busy={lift.isPending} error={lift.isError && !errs['/confirm_text'] ? errText(lift.error, t) : null}
          onSubmit={(reason) => lift.mutate({ version: f.version, reason, confirm_text: typed }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); } })}>
          <label className="block text-sm font-semibold">{t('rules.type_to_confirm', { text: FREEZE_CONFIRM })}
            <input className="input mono mt-1 font-normal" dir="ltr" data-testid="freeze-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
          <FieldErr errs={errs} path="/confirm_text" />
        </FormDialog>
      )}
    </section>
  );
}

export function Dlp() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useDlp(), pub = usePublishDlp();
  const [f, setF] = useState<{ cw: string; te: string; from: string } | null>(null);
  const [open, setOpen] = useState(false);
  const cur = q.data?.current;
  const v = f ?? { cw: String(cur?.cw_months ?? ''), te: String(cur?.te_months ?? ''), from: '' };
  const errs = fieldErrors(pub.error);
  const bad = ![v.cw, v.te].every((x) => x !== '' && Number.isInteger(Number(x)) && Number(x) >= 0 && Number(x) <= 120) || !v.from;
  return (
    <div className="space-y-4" data-testid="page-dlp">
      <section className="card space-y-3 p-4">
        <h2 className="font-bold">{t('rules.dlp')}</h2>
        <p className="text-sm text-mute">{t('rules.dlp_note')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm font-semibold">{t('rules.dlp_cw')}<input type="number" min={0} max={120} className="input mt-1 font-normal" data-testid="dlp-cw" value={v.cw} onChange={(e) => setF({ ...v, cw: e.target.value })} /><FieldErr errs={errs} path="/cw_months" /></label>
          <label className="text-sm font-semibold">{t('rules.dlp_te')}<input type="number" min={0} max={120} className="input mt-1 font-normal" data-testid="dlp-te" value={v.te} onChange={(e) => setF({ ...v, te: e.target.value })} /><FieldErr errs={errs} path="/te_months" /></label>
          <label className="text-sm font-semibold">{t('rules.effective_from')}<input type="date" className="input mt-1 font-normal" data-testid="dlp-from" value={v.from} onChange={(e) => setF({ ...v, from: e.target.value })} /><FieldErr errs={errs} path="/effective_from" /></label>
        </div>
        <button className="btn btn-accent" data-testid="dlp-publish" disabled={bad} onClick={() => setOpen(true)}>{t('rules.publish_version')}</button>
      </section>
      <section className="card overflow-x-auto p-4">
        <h2 className="mb-2 font-bold">{t('rules.versions')}</h2>
        <table className="w-full text-sm"><thead className="text-mute"><tr><th className="p-2 text-start">{t('rules.col_version')}</th><th className="p-2 text-start">CW</th><th className="p-2 text-start">TE</th><th className="p-2 text-start">{t('rules.effective_from')}</th><th className="p-2 text-start">{t('common.reason')}</th></tr></thead>
          <tbody data-testid="dlp-versions">{(q.data?.history ?? []).map((h) => (
            <tr key={h.version} className="border-t border-line" data-testid={`dlp-version-${h.version}`}><td className="p-2">v{h.version}{h.version === cur?.version && <span className="chip ms-2 bg-doneBg text-doneInk">{t('rules.current')}</span>}</td><td className="p-2">{h.cw_months}</td><td className="p-2">{h.te_months}</td><td className="mono p-2 text-xs">{h.effective_from}</td><td className="p-2 text-mute">{h.reason}</td></tr>))}</tbody></table>
      </section>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="dlp-dialog" title={t('rules.publish_version')} busy={pub.isPending} error={pub.isError && !Object.keys(errs).length ? errText(pub.error, t) : null}
          onSubmit={(reason) => pub.mutate({ cw_months: Number(v.cw), te_months: Number(v.te), effective_from: v.from, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </div>
  );
}

export function Idle() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useIdle(), set = useSetIdle();
  const [f, setF] = useState<{ enabled: boolean; days: string } | null>(null);
  const [open, setOpen] = useState(false);
  const v = f ?? { enabled: q.data?.enabled ?? true, days: String(q.data?.working_days ?? 2) };
  const errs = fieldErrors(set.error);
  const n = Number(v.days), bad = !Number.isInteger(n) || n < 1 || n > 30;
  return (
    <section className="card space-y-3 p-4" data-testid="page-idle">
      <h2 className="font-bold">{t('rules.idle')}</h2>
      <p className="text-sm text-mute">{t('rules.idle_note')}</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="idle-enabled" checked={v.enabled} onChange={(e) => setF({ ...v, enabled: e.target.checked })} />{t('rules.idle_enabled')}</label>
      <label className="block max-w-48 text-sm font-semibold">{t('rules.idle_days')}<input type="number" min={1} max={30} className="input mt-1 font-normal" aria-invalid={bad} data-testid="idle-days" value={v.days} onChange={(e) => setF({ ...v, days: e.target.value })} />
        <span className="text-xs font-normal text-mute">{t('rules.range', { min: 1, max: 30 })}</span><FieldErr errs={errs} path="/working_days" /></label>
      {bad && <p role="alert" className="text-xs text-lateInk" data-testid="idle-invalid">{t('rules.range', { min: 1, max: 30 })}</p>}
      <button className="btn btn-accent" data-testid="idle-save" disabled={bad || !q.data} onClick={() => setOpen(true)}>{t('common.save')}</button>
      {open && q.data && (
        <FormDialog open onClose={() => setOpen(false)} testid="idle-dialog" title={t('rules.idle')} busy={set.isPending} error={set.isError && !Object.keys(errs).length ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: q.data.version, enabled: v.enabled, working_days: n, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </section>
  );
}
