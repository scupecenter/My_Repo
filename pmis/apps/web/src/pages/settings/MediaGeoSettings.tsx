import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMediaGeoSettings, useMediaGeoStatus, useScanMediaGeo, useSetMediaGeoSettings, type MediaGeoSettings } from '@/api/media';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { UnsavedGuard } from '@/lib/unsavedGuard';

type Draft = Pick<MediaGeoSettings, 'enabled' | 'max_distance_m' | 'flag_missing' | 'panorama' | 'panorama_min_ratio' | 'panorama_min_width_px' | 'drone_makes'>;

/** Settings > Documents > Media, second card (Media geotag): where a photo was taken, what counts as far from its site, panorama and drone detection, and the scan of older images. */
export function MediaGeoSettingsCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useMediaGeoSettings(), set = useSetMediaGeoSettings(), scan = useScanMediaGeo();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [makes, setMakes] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const status = useMediaGeoStatus(!!q.data?.can_edit);
  if (!q.data) return <QueryFallback queries={[q]} testid="mg-loading" />;
  const cur = q.data;
  const base: Draft = { enabled: cur.enabled, max_distance_m: cur.max_distance_m, flag_missing: cur.flag_missing, panorama: cur.panorama, panorama_min_ratio: cur.panorama_min_ratio, panorama_min_width_px: cur.panorama_min_width_px, drone_makes: cur.drone_makes };
  const list = (x: string) => x.split(/[,\n]+/).map((m) => m.trim()).filter(Boolean);
  const v: Draft = { ...(draft ?? base), drone_makes: makes !== null ? list(makes) : (draft ?? base).drone_makes };
  const dirty = JSON.stringify(v) !== JSON.stringify(base);
  const ro = !cur.can_edit;
  const patch = (p: Partial<Draft>) => setDraft({ ...v, ...p });
  const bool = (id: string, label: string, note: string, val: boolean, on: (b: boolean) => void) => (
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" data-testid={id} checked={val} disabled={ro} onChange={(e) => on(e.target.checked)} />
      <span><span className="font-semibold">{label}</span><span className="block text-xs text-mute">{note}</span></span></label>);
  const num = (id: string, label: string, note: string, val: number, on: (n: number) => void, min: number, max: number, step = 1) => (
    <label className="block text-xs font-semibold text-mute">{label}<input type="number" min={min} max={max} step={step} className="input mt-1 w-full" data-testid={id} value={val} disabled={ro} onChange={(e) => on(Number(e.target.value))} /><span className="font-normal">{note}</span></label>);
  const done = () => { setDraft(null); setMakes(null); };
  const st = status.data;
  return (
    <section className="card mt-4 space-y-4 p-4" data-testid="page-media-geo-settings">
      <div><h2 className="font-bold">{t('mediaGeo.title')}</h2><p className="text-sm text-mute">{t('mediaGeo.note')}</p></div>
      {bool('mg-enabled', t('mediaGeo.enabled'), t('mediaGeo.enabled_note'), v.enabled, (b) => patch({ enabled: b }))}
      <div className="grid gap-3 sm:grid-cols-3">
        {num('mg-distance', t('mediaGeo.distance'), t('mediaGeo.distance_note'), v.max_distance_m, (n) => patch({ max_distance_m: n }), 50, 100000)}
        {num('mg-ratio', t('mediaGeo.ratio'), t('mediaGeo.ratio_note'), v.panorama_min_ratio, (n) => patch({ panorama_min_ratio: n }), 1.5, 4, 0.1)}
        {num('mg-width', t('mediaGeo.width'), t('mediaGeo.width_note'), v.panorama_min_width_px, (n) => patch({ panorama_min_width_px: n }), 1000, 30000, 100)}
      </div>
      {bool('mg-missing', t('mediaGeo.missing'), t('mediaGeo.missing_note'), v.flag_missing, (b) => patch({ flag_missing: b }))}
      {bool('mg-panorama', t('mediaGeo.panorama'), t('mediaGeo.panorama_note'), v.panorama, (b) => patch({ panorama: b }))}
      <label className="block text-xs font-semibold text-mute">{t('mediaGeo.makes')}
        <input dir="ltr" className="input mt-1 w-full" data-testid="mg-makes" disabled={ro} value={makes ?? v.drone_makes.join(', ')} onChange={(e) => setMakes(e.target.value)} />
        <span className="font-normal">{t('mediaGeo.makes_note')}</span></label>
      {!ro && <UnsavedGuard scope="settings" dirty={dirty} needsReason label={t('ui.guard_settings')}
        onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: cur.version, ...v, reason }, { onSuccess: () => { done(); res(true); }, onError: () => res(false) }))} />}
      {ro ? <p className="text-sm text-mute" data-testid="mg-readonly">{t('mediaGeo.readonly')}</p>
        : <button className="btn btn-accent" data-testid="mg-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>}
      {!ro && (
        <div className="space-y-2 border-t border-line pt-3" data-testid="mg-scan-box">
          <h3 className="text-sm font-semibold">{t('mediaGeo.scan_title')}</h3>
          <p className="text-xs text-mute">{t('mediaGeo.scan_note')}</p>
          {st && <p className="text-sm" data-testid="mg-status">{t('mediaGeo.status', { scanned: st.scanned, located: st.with_location, panorama: st.panorama, drone: st.drone, pending: st.pending })}</p>}
          <button type="button" className="btn" data-testid="mg-scan" disabled={scan.isPending || !cur.enabled || (st?.pending ?? 0) === 0} onClick={() => scan.mutate(undefined, { onSuccess: (r) => toast(t('mediaGeo.scan_done', { done: r.done, pending: r.pending })) })}>{t('mediaGeo.scan')}</button>
          {scan.isError && <p role="alert" className="text-lateInk" data-testid="mg-scan-error">{errText(scan.error, t)}</p>}
        </div>
      )}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="mg-dialog" title={t('mediaGeo.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, ...v, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); done(); } })}>
          <p className="text-sm text-mute">{t('mediaGeo.confirm')}</p>
        </FormDialog>
      )}
    </section>
  );
}
