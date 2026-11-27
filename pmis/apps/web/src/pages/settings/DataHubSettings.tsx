import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { DATA_HUB_SEED, HUB_SCREENS, HUB_VIEWS, HUB_WIDGETS, type HubScreen, type HubView, type HubWidget, type UiDataHub } from '@/api/dataHub';
import { UI_FEATURES_SEED, useSaveUiFeatures, useUiFeaturesSetting, type UiFeatures } from '@/api/uiFeatures';
import { errText, FormDialog } from '@/components/FormDialog';
import { canEditDisplayDefaults } from '@/components/TableStandard';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { FieldErr } from './Calendar';

/**
 * Administration > Settings > Screens > Data hub: every Data hub setting in one place. Which widgets show on the landing page, whether the Uploads & batches
 * entry carries its count badge, and the default view of each records-style page (cards, rows, table, compact list). A person can still choose another view
 * on a page; that choice stays on their device. Saved with a reason, If-Match and an audit row, like the other interface features (ui.features, section data_hub).
 */
export function DataHubSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true).data;
  const q = useUiFeaturesSetting(), save = useSaveUiFeatures();
  const [f, setF] = useState<UiDataHub | null>(null);
  const [open, setOpen] = useState(false);
  const can = canEditDisplayDefaults(me);
  const errs = fieldErrors(save.error);
  if (q.isError) return <p role="alert" className="card p-4 text-lateInk" data-testid="dh-settings-error">{errText(q.error, t)}</p>;
  if (!q.data) return <p className="text-mute">{t('common.loading')}</p>;
  const saved = q.data.sections as Partial<UiFeatures>;
  const base: UiDataHub = { ...DATA_HUB_SEED, ...saved.data_hub, widgets: { ...DATA_HUB_SEED.widgets, ...saved.data_hub?.widgets }, default_view: { ...DATA_HUB_SEED.default_view, ...saved.data_hub?.default_view } };
  const v = f ?? base;
  return (
    <div className="space-y-4" data-testid="page-dh-settings">
      <section className="card space-y-3 p-4">
        <div><h2 className="font-bold">{t('dhs.widgets_title')}</h2><p className="text-sm text-mute">{t('dhs.widgets_note')}</p></div>
        {HUB_WIDGETS.map((k: HubWidget) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!can} data-testid={`dh-widget-${k}`} checked={v.widgets[k]} onChange={(e) => setF({ ...v, widgets: { ...v.widgets, [k]: e.target.checked } })} />
            {t(`dhs.widget_${k}`)}
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={!can} data-testid="dh-badge" checked={v.badge} onChange={(e) => setF({ ...v, badge: e.target.checked })} />
          {t('dhs.badge')}
        </label>
      </section>
      <section className="card space-y-3 p-4">
        <div><h2 className="font-bold">{t('dhs.views_title')}</h2><p className="text-sm text-mute">{t('dhs.views_note')}</p></div>
        {HUB_SCREENS.map((k: HubScreen) => (
          <fieldset key={k} className="space-y-1" disabled={!can}>
            <legend className="text-sm font-semibold">{t(`dhs.screen_${k}`)}</legend>
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t(`dhs.screen_${k}`)}>
              {HUB_VIEWS.map((x: HubView) => (
                <button key={x} type="button" role="radio" aria-checked={v.default_view[k] === x} data-testid={`dh-view-${k}-${x}`} title={t(`dhs.view_${x}`)}
                  onClick={() => setF({ ...v, default_view: { ...v.default_view, [k]: x } })}
                  className={`btn px-2 py-1 text-xs ${v.default_view[k] === x ? 'bg-accent text-accentInk' : ''}`}>{t(`dhs.view_${x}`)}</button>
              ))}
            </div>
            <FieldErr errs={errs} path={`/sections/data_hub/default_view/${k}`} />
          </fieldset>
        ))}
      </section>
      {q.data.updated_by && <p className="text-xs text-mute">{t('tstd.settings_updated', { name: q.data.updated_by.display_name, at: q.data.updated_at ?? '' })}</p>}
      {can ? (
        <div className="flex gap-2">
          <button type="button" className="btn btn-accent" data-testid="dh-save" disabled={!f} onClick={() => setOpen(true)}>{t('common.save')}</button>
          <button type="button" className="btn" data-testid="dh-discard" disabled={!f} onClick={() => setF(null)}>{t('common.cancel')}</button>
        </div>
      ) : <p className="text-sm text-mute" data-testid="dh-read-only">{t('tstd.settings_read_only')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="dh-dialog" title={t('dhs.title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate({ sections: { ...UI_FEATURES_SEED, ...saved, data_hub: v }, reason, version: q.data.version }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </div>
  );
}
