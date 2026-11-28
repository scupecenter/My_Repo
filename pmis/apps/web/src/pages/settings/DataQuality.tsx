import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { DQ_CHECKS, DQ_FIELDS, useDataQualityReport, useDataQualitySettings, useSetDataQualitySettings, type DataQualityInput } from '@/api/dataQuality';
import { useRegions } from '@/api/sites';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { UnsavedGuard } from '@/lib/unsavedGuard';

type Draft = Omit<DataQualityInput, 'reason'>;
const cell = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v));

/**
 * Settings > Data > Quality (D3): the read-only Data quality report and the setting that switches its checks on. The report writes nothing, shows only
 * the regions of the person, and names what is wrong without showing field values. The setting is audited, with a reason, a step-up and If-Match.
 */
export function DataQualityScreen() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useDataQualitySettings(), set = useSetDataQualitySettings();
  const regs = useRegions().data ?? [];
  const [check, setCheck] = useState('');
  const [region, setRegion] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  const rep = useDataQualityReport(check, region, !!q.data?.enabled);
  if (!q.data) return <QueryFallback queries={[q]} testid="dq-loading" />;
  const cur = q.data;
  const base: Draft = { enabled: cur.enabled, checks: cur.checks, required_site_fields: cur.required_site_fields, max_rows: cur.max_rows };
  const v = draft ?? base;
  const dirty = JSON.stringify(v) !== JSON.stringify(base);
  const ro = !cur.can_edit;
  const patch = (p: Partial<Draft>) => setDraft({ ...v, ...p });
  const toggle = (list: string[], k: string, on: boolean) => (on ? [...list, k] : list.filter((x) => x !== k));
  const save = (reason: string, done: (ok: boolean) => void) => set.mutate({ version: cur.version, ...v, reason }, { onSuccess: () => { setDraft(null); done(true); }, onError: () => done(false) });
  return (
    <div className="space-y-4" data-testid="page-data-quality">
      <section className="card space-y-3 p-4">
        <div><h2 className="font-bold">{t('dq.title')}</h2><p className="text-sm text-mute">{t('dq.note')}</p></div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" data-testid="dq-enabled" checked={v.enabled} disabled={ro} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span className="font-semibold">{t('dq.enabled')}</span></label>
        <fieldset><legend className="mb-1 text-sm font-semibold">{t('dq.checks')}</legend>
          <div className="flex flex-wrap gap-2">{DQ_CHECKS.map((k) => (
            <label key={k} className="chip cursor-pointer gap-1 border border-line bg-card"><input type="checkbox" data-testid={`dq-on-${k}`} disabled={ro} checked={v.checks.includes(k)} onChange={(e) => patch({ checks: toggle(v.checks, k, e.target.checked) })} />{t(`dq.check_${k}`)}</label>))}</div>
        </fieldset>
        <fieldset><legend className="mb-1 text-sm font-semibold">{t('dq.fields')}</legend>
          <div className="flex flex-wrap gap-2">{DQ_FIELDS.map((k) => (
            <label key={k} className="chip cursor-pointer gap-1 border border-line bg-card"><input type="checkbox" data-testid={`dq-field-${k}`} disabled={ro} checked={v.required_site_fields.includes(k)} onChange={(e) => patch({ required_site_fields: toggle(v.required_site_fields, k, e.target.checked) })} />{t(`dq.field_${k}`)}</label>))}</div>
          <p className="mt-1 text-xs text-mute">{t('dq.fields_note')}</p>
        </fieldset>
        <label className="block w-40 text-xs font-semibold text-mute">{t('dq.max_rows')}<input type="number" min={10} max={500} className="input mt-1 w-full" data-testid="dq-max" value={v.max_rows} disabled={ro} onChange={(e) => patch({ max_rows: Number(e.target.value) })} /></label>
        {!ro && <UnsavedGuard scope="settings" dirty={dirty} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => save(reason, res))} />}
        {ro ? <p className="text-sm text-mute" data-testid="dq-readonly">{t('dq.readonly')}</p>
          : <button className="btn btn-accent" data-testid="dq-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>}
        {open && (
          <FormDialog open onClose={() => setOpen(false)} testid="dq-dialog" title={t('dq.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
            onSubmit={(reason) => set.mutate({ version: cur.version, ...v, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })}>
            <p className="text-sm text-mute">{t('dq.confirm')}</p>
          </FormDialog>
        )}
      </section>
      <section className="card space-y-3 p-4" data-testid="dq-report">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="me-auto font-bold">{t('dq.report')}</h2>
          <label className="text-xs font-semibold text-mute">{t('dq.pick_check')}
            <select className="input mt-1 block" data-testid="dq-check" value={check} onChange={(e) => setCheck(e.target.value)}>
              <option value="">{t('dq.all_checks')}</option>{DQ_CHECKS.map((k) => <option key={k} value={k}>{t(`dq.check_${k}`)}</option>)}</select></label>
          <label className="text-xs font-semibold text-mute">{t('dq.pick_region')}
            <select className="input mt-1 block" data-testid="dq-region" value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">{t('dq.all_regions')}</option>{regs.map((r) => <option key={r.id} value={String(r.id)}>{i18n.language === 'ar' && r.name_ar ? r.name_ar : r.name_en}</option>)}</select></label>
        </div>
        {!cur.enabled ? <p className="text-sm text-mute" data-testid="dq-off">{t('dq.off')}</p>
          : !rep.data ? <QueryFallback queries={[rep]} testid="dq-report-loading" />
          : rep.data.checks.length === 0 ? <p className="text-sm text-mute">{t('dq.none_on')}</p>
          : rep.data.checks.map((c) => (
            <div key={c.check} data-testid={`dq-result-${c.check}`}>
              <h3 className="text-sm font-semibold">{t(`dq.check_${c.check}`)} <span className="chip bg-accentSoft text-accentText" data-testid={`dq-count-${c.check}`}>{c.count}</span></h3>
              <p className="text-xs text-mute">{t(`dq.check_${c.check}_help`)}</p>
              {c.count === 0 ? <p className="text-sm text-mute">{t('dq.clean')}</p> : (
                <div className="overflow-x-auto"><table className="mt-1 w-full text-sm"><tbody>
                  {c.rows.map((r, i) => (
                    <tr key={i} className="border-t border-line" data-testid={`dq-row-${c.check}`}>
                      {Object.entries(r).filter(([k]) => !k.endsWith('_id') || k === 'region_id').map(([k, val]) => <td key={k} className="p-1"><span className="text-xs text-mute">{k}</span> <span className="mono">{cell(val)}</span></td>)}
                      {typeof r.site_id === 'string' && <td className="p-1"><Link className="text-accentText underline" to={`/sites/${r.site_id}`}>{t('dq.open_site')}</Link></td>}
                    </tr>))}
                </tbody></table></div>)}
              {c.truncated && <p className="text-xs text-mute" data-testid={`dq-more-${c.check}`}>{t('dq.truncated', { n: rep.data?.max_rows })}</p>}
            </div>))}
      </section>
    </div>
  );
}
