import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useContractorPerfThresholds, useSetContractorPerfThresholds } from '@/api/settings';
import type { ContractorPerformanceSettings } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { QueryFallback } from '@/components/States';

type Pairs = 'snag_overdue_pct' | 'snag_return_pct' | 'quality_fail_pct' | 'contract_expiry_days';
const PAIRS: Pairs[] = ['snag_overdue_pct', 'snag_return_pct', 'quality_fail_pct', 'contract_expiry_days'];
type Form = Record<'min_sample' | `${Pairs}_amber` | `${Pairs}_red`, string>;

const toForm = (s: ContractorPerformanceSettings): Form => ({
  min_sample: String(s.min_sample),
  ...Object.fromEntries(PAIRS.flatMap((k) => [[`${k}_amber`, String(s[k].amber)], [`${k}_red`, String(s[k].red)]])),
}) as Form;
const whole = (v: string, max: number) => v.trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max;

/** Settings, Registers, Contractors: the thresholds of the contractor performance view (contract 0.15.89); read only unless the caller can edit. */
export function ContractorPerfThresholds() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useContractorPerfThresholds(), set = useSetContractorPerfThresholds();
  const [f, setF] = useState<Form | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <section className="card p-4" data-testid="page-contractor-perf"><QueryFallback queries={[q]} testid="cperf-loading" /></section>;
  const v = f ?? toForm(q.data.thresholds);
  const errs = fieldErrors(set.error);
  const max = (k: Pairs) => (k === 'contract_expiry_days' ? 365 : 100);
  const bad = !whole(v.min_sample, 100) || Number(v.min_sample) < 1
    || PAIRS.some((k) => !whole(v[`${k}_amber`], max(k)) || !whole(v[`${k}_red`], max(k))
      || (k === 'contract_expiry_days' ? Number(v[`${k}_red`]) > Number(v[`${k}_amber`]) : Number(v[`${k}_red`]) < Number(v[`${k}_amber`])));
  const body = (): ContractorPerformanceSettings => ({
    min_sample: Number(v.min_sample),
    snag_overdue_pct: { amber: Number(v.snag_overdue_pct_amber), red: Number(v.snag_overdue_pct_red) },
    snag_return_pct: { amber: Number(v.snag_return_pct_amber), red: Number(v.snag_return_pct_red) },
    quality_fail_pct: { amber: Number(v.quality_fail_pct_amber), red: Number(v.quality_fail_pct_red) },
    contract_expiry_days: { amber: Number(v.contract_expiry_days_amber), red: Number(v.contract_expiry_days_red) },
  });
  const ro = !q.data.can_edit;
  return (
    <section className="card space-y-3 p-4" data-testid="page-contractor-perf">
      <h2 className="font-bold">{t('contractorPerf.thresholds_title')}</h2>
      <p className="text-sm text-mute">{t('contractorPerf.thresholds_note')}</p>
      <label className="block max-w-56 text-sm font-semibold">{t('contractorPerf.min_sample')}
        <input type="number" min={1} max={100} disabled={ro} className="input mt-1 font-normal" data-testid="cperf-min_sample" value={v.min_sample} onChange={(e) => setF({ ...v, min_sample: e.target.value })} /></label>
      {PAIRS.map((k) => (
        <fieldset key={k} className="flex flex-wrap items-end gap-3">
          <legend className="text-sm font-semibold">{t(`contractorPerf.${k}`)}</legend>
          <label className="text-sm">{t('contractorPerf.amber')}
            <input type="number" min={0} max={max(k)} disabled={ro} className="input mt-1 w-28" data-testid={`cperf-${k}-amber`} value={v[`${k}_amber`]} onChange={(e) => setF({ ...v, [`${k}_amber`]: e.target.value })} /></label>
          <label className="text-sm">{t('contractorPerf.red')}
            <input type="number" min={0} max={max(k)} disabled={ro} className="input mt-1 w-28" data-testid={`cperf-${k}-red`} value={v[`${k}_red`]} onChange={(e) => setF({ ...v, [`${k}_red`]: e.target.value })} /></label>
          {errs[`/thresholds/${k}`] && <p role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs[`/thresholds/${k}`]}`, { defaultValue: errs[`/thresholds/${k}`] })}</p>}
        </fieldset>
      ))}
      {!ro && <button className="btn btn-accent" data-testid="cperf-save" disabled={bad || !f} onClick={() => setOpen(true)}>{t('common.save')}</button>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="cperf-dialog" title={t('contractorPerf.thresholds_title')} busy={set.isPending}
          error={set.isError && !Object.keys(errs).length ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: q.data.version, body: { reason, thresholds: body() } }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </section>
  );
}
