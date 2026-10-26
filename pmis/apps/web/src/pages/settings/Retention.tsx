import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRetention, useSetRetention } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { isReduction, RETENTION_MIN, retentionErrors } from '@/lib/policy';
import { FieldErr } from './Calendar';

export function Retention() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useRetention(), set = useSetRetention();
  const [f, setF] = useState<{ sys: string; sec: string } | null>(null);
  const [open, setOpen] = useState(false);
  const cur = q.data;
  if (!cur) return <p>{t('common.loading')}</p>;
  const v = f ?? { sys: String(cur.system_log_days), sec: String(cur.security_log_days) };
  const next = { system_log_days: Number(v.sys), security_log_days: Number(v.sec) };
  const errs = { ...fieldErrors(set.error), ...retentionErrors(next) };
  const reduce = isReduction(cur, next);
  return (
    <section className="card space-y-3 p-4" data-testid="page-retention">
      <h2 className="font-bold">{t('ret.title')}</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm font-semibold">{t('ret.system')}<input type="number" className="input mt-1 font-normal" data-testid="ret-system" value={v.sys} onChange={(e) => setF({ ...v, sys: e.target.value })} />
          <span className="text-xs font-normal text-mute" data-testid="ret-system-min">{t('ret.minimum', { min: RETENTION_MIN.system_log_days })}</span><FieldErr errs={errs} path="/system_log_days" /></label>
        <label className="text-sm font-semibold">{t('ret.security')}<input type="number" className="input mt-1 font-normal" data-testid="ret-security" value={v.sec} onChange={(e) => setF({ ...v, sec: e.target.value })} />
          <span className="text-xs font-normal text-mute" data-testid="ret-security-min">{t('ret.minimum', { min: RETENTION_MIN.security_log_days })}</span><FieldErr errs={errs} path="/security_log_days" /></label>
        <div className="text-sm font-semibold">{t('ret.audit')}<div className="input mt-1 bg-card2 font-normal" data-testid="ret-audit">{t('ret.audit_fixed', { years: cur.audit_log_years })}</div><span className="text-xs font-normal text-mute">{t('ret.audit_note')}</span></div>
      </div>
      {reduce && <div role="alert" className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="ret-warning"><AlertTriangle size={16} />{t('ret.warning')}</div>}
      <button className="btn btn-accent" data-testid="ret-save" disabled={Object.keys(retentionErrors(next)).length > 0 || !f} onClick={() => setOpen(true)}>{t('common.save')}</button>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="ret-dialog" title={t('ret.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, body: { reason, ...next } }, { onSuccess: () => { toast(t(reduce ? 'ret.saved_reduced' : 'settings.audited')); setOpen(false); setF(null); } })}>
          {reduce && <p className="rounded-md bg-card2 p-2 text-sm text-mute">{t('ret.warning')}</p>}
        </FormDialog>
      )}
    </section>
  );
}
