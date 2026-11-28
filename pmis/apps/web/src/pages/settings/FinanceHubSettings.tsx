import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { FINANCE_HUB_SEED, FINANCE_WIDGETS, type FinanceWidget, type UiFinanceHub } from '@/api/financeHub';
import { UI_FEATURES_SEED, useSaveUiFeatures, useUiFeaturesSetting, type UiFeatures } from '@/api/uiFeatures';
import { errText, FormDialog } from '@/components/FormDialog';
import { canEditDisplayDefaults } from '@/components/TableStandard';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { FieldErr } from './Calendar';

/**
 * Administration > Settings > Screens > Finance hub: every Finance hub setting in one place. Which cards show on the page, after how many days a
 * disbursed, unsettled advance warns, and the two aging bounds of the open-invoice buckets. Saved with a reason, If-Match and an audit row, like the
 * other interface features (ui.features, section finance_hub).
 */
export function FinanceHubSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true).data;
  const q = useUiFeaturesSetting(), save = useSaveUiFeatures();
  const [f, setF] = useState<UiFinanceHub | null>(null);
  const [open, setOpen] = useState(false);
  const can = canEditDisplayDefaults(me);
  const errs = fieldErrors(save.error);
  if (q.isError) return <p role="alert" className="card p-4 text-lateInk" data-testid="fh-settings-error">{errText(q.error, t)}</p>;
  if (!q.data) return <p className="text-mute">{t('common.loading')}</p>;
  const saved = q.data.sections as Partial<UiFeatures>;
  const base: UiFinanceHub = { ...FINANCE_HUB_SEED, ...saved.finance_hub, widgets: { ...FINANCE_HUB_SEED.widgets, ...saved.finance_hub?.widgets } };
  const v = f ?? base;
  const setNum = (key: 'settle_warn_days', raw: string) => setF({ ...v, [key]: Number(raw) });
  const setAging = (i: 0 | 1, raw: string) => { const a: [number, number] = [...v.aging_days] as [number, number]; a[i] = Number(raw); setF({ ...v, aging_days: a }); };
  return (
    <div className="space-y-4" data-testid="page-fh-settings">
      <section className="card space-y-3 p-4">
        <div><h2 className="font-bold">{t('fhs.widgets_title')}</h2><p className="text-sm text-mute">{t('fhs.widgets_note')}</p></div>
        {FINANCE_WIDGETS.map((k: FinanceWidget) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!can} data-testid={`fh-widget-${k}`} checked={v.widgets[k]} onChange={(e) => setF({ ...v, widgets: { ...v.widgets, [k]: e.target.checked } })} />
            {t(`fhs.widget_${k}`)}
          </label>
        ))}
      </section>
      <section className="card space-y-3 p-4">
        <div><h2 className="font-bold">{t('fhs.thresholds_title')}</h2><p className="text-sm text-mute">{t('fhs.thresholds_note')}</p></div>
        <label className="flex items-center gap-2 text-sm">
          <span className="min-w-52">{t('fhs.settle_warn_days')}</span>
          <input type="number" min={1} max={365} disabled={!can} data-testid="fh-settle-warn" className="input w-24" value={v.settle_warn_days} onChange={(e) => setNum('settle_warn_days', e.target.value)} />
        </label>
        <FieldErr errs={errs} path="/sections/finance_hub/settle_warn_days" />
        <div className="flex items-center gap-2 text-sm">
          <span className="min-w-52">{t('fhs.aging_days')}</span>
          <input type="number" min={1} max={365} disabled={!can} data-testid="fh-aging-0" className="input w-24" value={v.aging_days[0]} onChange={(e) => setAging(0, e.target.value)} />
          <input type="number" min={1} max={365} disabled={!can} data-testid="fh-aging-1" className="input w-24" value={v.aging_days[1]} onChange={(e) => setAging(1, e.target.value)} />
        </div>
        <FieldErr errs={errs} path="/sections/finance_hub/aging_days" />
      </section>
      {q.data.updated_by && <p className="text-xs text-mute">{t('tstd.settings_updated', { name: q.data.updated_by.display_name, at: q.data.updated_at ?? '' })}</p>}
      {can ? (
        <div className="flex gap-2">
          <button type="button" className="btn btn-accent" data-testid="fh-save" disabled={!f} onClick={() => setOpen(true)}>{t('common.save')}</button>
          <button type="button" className="btn" data-testid="fh-discard" disabled={!f} onClick={() => setF(null)}>{t('common.cancel')}</button>
        </div>
      ) : <p className="text-sm text-mute" data-testid="fh-read-only">{t('tstd.settings_read_only')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="fh-dialog" title={t('fhs.title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate({ sections: { ...UI_FEATURES_SEED, ...saved, finance_hub: v }, reason, version: q.data.version }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </div>
  );
}
