import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDlp, useIdle, usePublishDlp, useSetIdle } from '@/api/settings';
import { FreezeCard } from '@/components/FreezePanel';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { FieldErr } from './Calendar';
import { DateInput } from '@/components/DateInput';

export { FREEZE_CONFIRM } from '@/components/FreezePanel';

export function Freeze() {
  return <FreezeCard />;
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
          <label className="text-sm font-semibold">{t('rules.effective_from')}<DateInput className="input mt-1 font-normal" data-testid="dlp-from" value={v.from} onChange={(e) => setF({ ...v, from: e.target.value })} /><FieldErr errs={errs} path="/effective_from" /></label>
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
