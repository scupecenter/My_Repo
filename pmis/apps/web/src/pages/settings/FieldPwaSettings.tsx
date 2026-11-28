import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { FIELD_PWA_SEED, type UiFieldPwa } from '@/api/fieldPwa';
import { UI_FEATURES_SEED, useSaveUiFeatures, useUiFeaturesSetting, type UiFeatures } from '@/api/uiFeatures';
import { errText, FormDialog } from '@/components/FormDialog';
import { canEditDisplayDefaults } from '@/components/TableStandard';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { FieldErr } from './Calendar';

const NUMS: { key: 'cache_hours' | 'max_queue' | 'max_photo_mb' | 'sync_seconds'; min: number; max: number }[] = [
  { key: 'cache_hours', min: 1, max: 168 }, { key: 'max_queue', min: 5, max: 200 }, { key: 'max_photo_mb', min: 1, max: 25 }, { key: 'sync_seconds', min: 15, max: 600 },
];

/**
 * Administration > Settings > Screens > Field mode: the switch of the narrow offline screen of the site teams (off by default) and its four limits.
 * Saved with a reason, If-Match and an audit row, like the other interface features (ui.features, section field_pwa).
 */
export function FieldPwaSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true).data;
  const q = useUiFeaturesSetting(), save = useSaveUiFeatures();
  const [f, setF] = useState<UiFieldPwa | null>(null);
  const [open, setOpen] = useState(false);
  const can = canEditDisplayDefaults(me);
  const errs = fieldErrors(save.error);
  if (q.isError) return <p role="alert" className="card p-4 text-lateInk" data-testid="fps-error">{errText(q.error, t)}</p>;
  if (!q.data) return <p className="text-mute">{t('common.loading')}</p>;
  const saved = q.data.sections as Partial<UiFeatures>;
  const v: UiFieldPwa = f ?? { ...FIELD_PWA_SEED, ...saved.field_pwa };
  return (
    <div className="space-y-4" data-testid="page-fps">
      <section className="card space-y-3 p-4">
        <div><h2 className="font-bold">{t('fps.title')}</h2><p className="text-sm text-mute">{t('fps.note')}</p></div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={!can} data-testid="fps-enabled" checked={v.enabled} onChange={(e) => setF({ ...v, enabled: e.target.checked })} />
          {t('fps.enabled')}
        </label>
        {NUMS.map((n) => (
          <label key={n.key} className="block text-sm">
            <span className="font-semibold">{t(`fps.${n.key}`)}</span>
            <input type="number" className="input mt-1 w-32" disabled={!can} min={n.min} max={n.max} data-testid={`fps-${n.key}`} value={v[n.key]}
              onChange={(e) => setF({ ...v, [n.key]: Number(e.target.value) })} />
            <span className="ms-2 text-xs text-mute">{n.min} – {n.max}</span>
            <FieldErr errs={errs} path={`/sections/field_pwa/${n.key}`} />
          </label>
        ))}
      </section>
      {q.data.updated_by && <p className="text-xs text-mute">{t('tstd.settings_updated', { name: q.data.updated_by.display_name, at: q.data.updated_at ?? '' })}</p>}
      {can ? (
        <div className="flex gap-2">
          <button type="button" className="btn btn-accent" data-testid="fps-save" disabled={!f} onClick={() => setOpen(true)}>{t('common.save')}</button>
          <button type="button" className="btn" data-testid="fps-discard" disabled={!f} onClick={() => setF(null)}>{t('common.cancel')}</button>
        </div>
      ) : <p className="text-sm text-mute" data-testid="fps-read-only">{t('tstd.settings_read_only')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="fps-dialog" title={t('fps.title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate({ sections: { ...UI_FEATURES_SEED, ...saved, field_pwa: v }, reason, version: q.data.version }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </div>
  );
}
