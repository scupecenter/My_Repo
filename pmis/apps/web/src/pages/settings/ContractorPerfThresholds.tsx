import { useState } from 'react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useTranslation } from 'react-i18next';
import { useContractorPerfThresholds, useContractorPerformance, useSetContractorPerfThresholds } from '@/api/settings';
import type { ContractorPerformanceSettings } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { QueryFallback } from '@/components/States';

type Pairs = 'snag_overdue_pct' | 'snag_return_pct' | 'quality_fail_pct' | 'contract_expiry_days';
const PAIRS: Pairs[] = ['snag_overdue_pct', 'snag_return_pct', 'quality_fail_pct', 'contract_expiry_days'];
type Form = Record<'min_sample' | 'pen_rate' | 'pen_currency' | 'pen_cap' | `${Pairs}_amber` | `${Pairs}_red`, string> & { ov: Record<string, string> };

const toForm = (s: ContractorPerformanceSettings): Form => ({
  min_sample: String(s.min_sample),
  pen_rate: s.penalty ? String(s.penalty.rate_per_day) : '', pen_currency: s.penalty?.currency ?? '', pen_cap: s.penalty?.cap != null ? String(s.penalty.cap) : '',
  ov: Object.fromEntries(Object.entries(s.penalty?.overrides ?? {}).map(([k, n]) => [k, String(n)])),
  ...Object.fromEntries(PAIRS.flatMap((k) => [[`${k}_amber`, String(s[k].amber)], [`${k}_red`, String(s[k].red)]])),
}) as unknown as Form;
const money = (v: string, max: number) => v.trim() === '' || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max && Math.abs(Number(v) * 100 - Math.round(Number(v) * 100)) < 1e-6);
const whole = (v: string, max: number) => v.trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max;

/** Settings, Registers, Contractors: the thresholds of the contractor performance view (contract 0.15.89); read only unless the caller can edit. */
export function ContractorPerfThresholds() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useContractorPerfThresholds(), set = useSetContractorPerfThresholds();
  const parties = useContractorPerformance().data?.items ?? [];
  const [f, setF] = useState<Form | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <section className="card p-4" data-testid="page-contractor-perf"><QueryFallback queries={[q]} testid="cperf-loading" /></section>;
  const v = f ?? toForm(q.data.thresholds);
  const errs = fieldErrors(set.error);
  const max = (k: Pairs) => (k === 'contract_expiry_days' ? 365 : 100);
  const penOn = v.pen_rate.trim() !== '';
  const penBad = penOn ? !money(v.pen_rate, 10_000_000) || !/^[A-Z]{3}$/.test(v.pen_currency) || !money(v.pen_cap, 1_000_000_000) || Object.values(v.ov).some((x) => !money(x, 10_000_000)) : false;
  const bad = penBad || !whole(v.min_sample, 100) || Number(v.min_sample) < 1
    || PAIRS.some((k) => !whole(v[`${k}_amber`], max(k)) || !whole(v[`${k}_red`], max(k))
      || (k === 'contract_expiry_days' ? Number(v[`${k}_red`]) > Number(v[`${k}_amber`]) : Number(v[`${k}_red`]) < Number(v[`${k}_amber`])));
  const body = (): ContractorPerformanceSettings => ({
    min_sample: Number(v.min_sample),
    snag_overdue_pct: { amber: Number(v.snag_overdue_pct_amber), red: Number(v.snag_overdue_pct_red) },
    snag_return_pct: { amber: Number(v.snag_return_pct_amber), red: Number(v.snag_return_pct_red) },
    quality_fail_pct: { amber: Number(v.quality_fail_pct_amber), red: Number(v.quality_fail_pct_red) },
    contract_expiry_days: { amber: Number(v.contract_expiry_days_amber), red: Number(v.contract_expiry_days_red) },
    ...(penOn ? { penalty: { rate_per_day: Number(v.pen_rate), currency: v.pen_currency, cap: v.pen_cap.trim() === '' ? null : Number(v.pen_cap),
      overrides: Object.fromEntries(Object.entries(v.ov).filter(([, x]) => x.trim() !== '').map(([k, x]) => [k, Number(x)])) } } : {}),
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
      {q.data.thresholds.penalty !== undefined || q.data.can_edit ? (
        <fieldset className="space-y-2 border-t border-line pt-3" data-testid="cperf-penalty">
          <legend className="text-sm font-semibold">{t('contractorPerf.pen_title')}</legend>
          <p className="text-xs text-mute">{t('contractorPerf.pen_note')}</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">{t('contractorPerf.pen_rate')}
              <input type="number" min={0} step="0.01" disabled={ro} className="input mt-1 w-32" data-testid="cperf-pen-rate" value={v.pen_rate} onChange={(e) => setF({ ...v, pen_rate: e.target.value })} /></label>
            <label className="text-sm">{t('contractorPerf.pen_currency')}
              <input maxLength={3} disabled={ro} className="input mt-1 w-20 uppercase" data-testid="cperf-pen-currency" value={v.pen_currency} onChange={(e) => setF({ ...v, pen_currency: e.target.value.toUpperCase() })} /></label>
            <label className="text-sm">{t('contractorPerf.pen_cap')}
              <input type="number" min={0} step="0.01" disabled={ro} className="input mt-1 w-36" data-testid="cperf-pen-cap" value={v.pen_cap} onChange={(e) => setF({ ...v, pen_cap: e.target.value })} /></label>
          </div>
          {penOn && parties.length > 0 && (
            <details className="text-sm" data-testid="cperf-pen-overrides">
              <summary className="cursor-pointer font-semibold">{t('contractorPerf.pen_overrides')}</summary>
              <div className="mt-2 grid max-w-xl grid-cols-[1fr_8rem] items-center gap-x-3 gap-y-1">
                {parties.map((p) => (
                  <label key={p.party_id} className="contents"><span className="truncate">{p.name}</span>
                    <input type="number" min={0} step="0.01" disabled={ro} className="input py-1" placeholder={v.pen_rate} aria-label={t('contractorPerf.pen_override_for', { name: p.name })} data-testid={`cperf-pen-ov-${p.party_id}`}
                      value={v.ov[p.party_id] ?? ''} onChange={(e) => setF({ ...v, ov: { ...v.ov, [p.party_id]: e.target.value } })} /></label>
                ))}
              </div>
            </details>
          )}
          {penBad && <p role="alert" className="text-xs text-lateInk">{t('contractorPerf.pen_invalid')}</p>}
          {(['rate_per_day', 'currency', 'cap', 'overrides'] as const).map((k) => errs[`/thresholds/penalty/${k}`] && <p key={k} role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs[`/thresholds/penalty/${k}`]}`, { defaultValue: errs[`/thresholds/penalty/${k}`] })}</p>)}
        </fieldset>
      ) : null}
      {!ro && <button className="btn btn-accent" data-testid="cperf-save" disabled={bad || !f} onClick={() => setOpen(true)}>{t('common.save')}</button>}
      <UnsavedGuard scope="settings" dirty={!!f} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: q.data.version, body: { reason, thresholds: body() } }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="cperf-dialog" title={t('contractorPerf.thresholds_title')} busy={set.isPending}
          error={set.isError && !Object.keys(errs).length ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: q.data.version, body: { reason, thresholds: body() } }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </section>
  );
}
