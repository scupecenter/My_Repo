import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { MAP_SEED, type UiMap } from '@/api/mapSettings';
import { UI_FEATURES_SEED, useSaveUiFeatures, useUiFeaturesSetting, type UiFeatures } from '@/api/uiFeatures';
import { errText, FormDialog } from '@/components/FormDialog';
import { canEditDisplayDefaults } from '@/components/TableStandard';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { isSafeTileTemplate } from '@/lib/tileMap';
import { CoordsCheck } from '@/components/CoordsCheck';
import { FieldErr } from './Calendar';

const ZOOMS: { key: 'min_zoom' | 'max_zoom' | 'default_zoom'; min: number; max: number }[] = [
  { key: 'min_zoom', min: 0, max: 19 }, { key: 'max_zoom', min: 0, max: 19 }, { key: 'default_zoom', min: 0, max: 19 },
];

/**
 * Administration > Settings > Screens > Map: the site map on real tiles. OFF by default. The tile address is a path on this server only (the tiles are served by the
 * customer's own server, see docs/ops/map-tiles.md), so no other host is ever contacted and the security policy of the pages is unchanged. Empty: the outline map stays.
 * Saved with a reason, If-Match and an audit row, like the other interface features (ui.features, section map).
 */
export function MapSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true).data;
  const q = useUiFeaturesSetting(), save = useSaveUiFeatures();
  const [f, setF] = useState<UiMap | null>(null);
  const [open, setOpen] = useState(false);
  const can = canEditDisplayDefaults(me);
  const errs = fieldErrors(save.error);
  if (q.isError) return <p role="alert" className="card p-4 text-lateInk" data-testid="map-settings-error">{errText(q.error, t)}</p>;
  if (!q.data) return <p className="text-mute">{t('common.loading')}</p>;
  const saved = q.data.sections as Partial<UiFeatures>;
  const v: UiMap = f ?? { ...MAP_SEED, ...saved.map };
  const urlBad = !isSafeTileTemplate(v.tile_url);
  const zoomBad = v.max_zoom < v.min_zoom;
  return (
    <div className="space-y-4" data-testid="page-map-settings">
      <CoordsCheck />
      <section className="card space-y-3 p-4">
        <div><h2 className="font-bold">{t('maps.title')}</h2><p className="text-sm text-mute">{t('maps.note')}</p></div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={!can} data-testid="maps-enabled" checked={v.enabled} onChange={(e) => setF({ ...v, enabled: e.target.checked })} />
          {t('maps.enabled')}
        </label>
        <label className="block text-sm">
          <span className="font-semibold">{t('maps.tile_url')}</span>
          <input type="text" dir="ltr" className="input mt-1 w-full max-w-xl" disabled={!can} maxLength={200} placeholder="/tiles/{z}/{x}/{y}.png" data-testid="maps-tile-url" value={v.tile_url}
            onChange={(e) => setF({ ...v, tile_url: e.target.value.trim() })} />
          <span className="block text-xs text-mute">{t('maps.tile_url_note')}</span>
          {urlBad && <span role="alert" className="block text-xs text-lateInk" data-testid="maps-tile-url-bad">{t('maps.tile_url_bad')}</span>}
          <FieldErr errs={errs} path="/sections/map/tile_url" />
        </label>
        <div className="flex flex-wrap gap-4">
          {ZOOMS.map((z) => (
            <label key={z.key} className="block text-sm">
              <span className="font-semibold">{t(`maps.${z.key}`)}</span>
              <input type="number" className="input mt-1 w-24" disabled={!can} min={z.min} max={z.max} data-testid={`maps-${z.key}`} value={v[z.key]} onChange={(e) => setF({ ...v, [z.key]: Number(e.target.value) })} />
              <FieldErr errs={errs} path={`/sections/map/${z.key}`} />
            </label>
          ))}
        </div>
        {zoomBad && <p role="alert" className="text-xs text-lateInk" data-testid="maps-zoom-bad">{t('maps.zoom_bad')}</p>}
        <div className="flex flex-wrap gap-4">
          <label className="block text-sm"><span className="font-semibold">{t('maps.center_lat')}</span>
            <input type="number" step="0.0001" className="input mt-1 w-32" disabled={!can} min={-85} max={85} data-testid="maps-center-lat" value={v.center_lat} onChange={(e) => setF({ ...v, center_lat: Number(e.target.value) })} />
            <FieldErr errs={errs} path="/sections/map/center_lat" /></label>
          <label className="block text-sm"><span className="font-semibold">{t('maps.center_lon')}</span>
            <input type="number" step="0.0001" className="input mt-1 w-32" disabled={!can} min={-180} max={180} data-testid="maps-center-lon" value={v.center_lon} onChange={(e) => setF({ ...v, center_lon: Number(e.target.value) })} />
            <FieldErr errs={errs} path="/sections/map/center_lon" /></label>
        </div>
        <label className="block text-sm">
          <span className="font-semibold">{t('maps.attribution')}</span>
          <input type="text" className="input mt-1 w-full max-w-xl" disabled={!can} maxLength={200} data-testid="maps-attribution" value={v.attribution} onChange={(e) => setF({ ...v, attribution: e.target.value })} />
          <span className="block text-xs text-mute">{t('maps.attribution_note')}</span>
          <FieldErr errs={errs} path="/sections/map/attribution" />
        </label>
      </section>
      {q.data.updated_by && <p className="text-xs text-mute">{t('tstd.settings_updated', { name: q.data.updated_by.display_name, at: q.data.updated_at ?? '' })}</p>}
      {can ? (
        <div className="flex gap-2">
          <button type="button" className="btn btn-accent" data-testid="maps-save" disabled={!f || urlBad || zoomBad} onClick={() => setOpen(true)}>{t('common.save')}</button>
          <button type="button" className="btn" data-testid="maps-discard" disabled={!f} onClick={() => setF(null)}>{t('common.cancel')}</button>
        </div>
      ) : <p className="text-sm text-mute" data-testid="maps-read-only">{t('tstd.settings_read_only')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="maps-dialog" title={t('maps.title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate({ sections: { ...UI_FEATURES_SEED, ...saved, map: v }, reason, version: q.data.version }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </div>
  );
}
