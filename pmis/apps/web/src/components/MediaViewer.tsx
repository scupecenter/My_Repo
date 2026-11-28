import * as Dialog from '@radix-ui/react-dialog';
import { Download, ExternalLink, Plane, RotateCw, Rows3, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { downloadFile } from '@/api/client';
import { mediaLinkTo, useMediaOriginal, useMediaThumb, type MediaItem, type MediaSite } from '@/api/media';
import { MediaGeoMap } from './MediaGeoMap';
import { PanoramaView } from './PanoramaView';
import { Tip } from './Tip';

/** Distance as people read it: metres under a kilometre, else kilometres with one decimal. */
export const fmtDistance = (m: number): string => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
export const fmtCoord = (n: number): string => n.toFixed(6);

/**
 * The viewer of one gallery item: a 360 degree panorama you turn, a photo (medium preview, full size on request), a drone photo with its altitude and
 * camera, or a video. Beside it: where it was taken, how far from the site, and a small drawing of both points. Opening it does not download the
 * original unless the item is a panorama (it needs the full image) or the person asks for the full size.
 */
export function MediaViewer({ it, ar, onClose }: { it: MediaItem; ar: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const pano = it.media_kind === 'panorama';
  const video = it.mime_type.startsWith('video/');
  const original = useMediaOriginal(it, !video && (pano || full));
  const thumb = useMediaThumb(it, 'medium');
  const typeName = (ar && it.type.name_ar) || it.type.name_en;
  const site = it.site as MediaSite | null;
  const g = it.geo;
  const to = mediaLinkTo(it.link as Record<string, unknown>);
  const src = original.data ?? (pano ? null : thumb.data ?? null);
  const row = (k: string, v: string | null | undefined, testid: string, mono = false) => v ? (
    <div className="flex justify-between gap-3"><dt className="text-mute">{k}</dt><dd className={mono ? 'mono' : ''} dir={mono ? 'ltr' : undefined} data-testid={testid}>{v}</dd></div>) : null;
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="motion-overlay fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="media-viewer" data-kind={it.media_kind} className="motion-panel card fixed inset-x-0 top-[4vh] z-[70] mx-auto flex max-h-[92vh] w-[min(1100px,96vw)] flex-col gap-3 overflow-y-auto p-4">
          <div className="flex items-center gap-2">
            <Dialog.Title className="min-w-0 flex-1 truncate text-lg font-bold">{typeName}</Dialog.Title>
            {pano && <span className="chip bg-accentSoft text-accentText" data-testid="viewer-kind"><RotateCw size={12} aria-hidden /> {t('media.kind_panorama')}</span>}
            {it.media_kind === 'drone' && <span className="chip bg-accentSoft text-accentText" data-testid="viewer-kind"><Plane size={12} aria-hidden /> {t('media.kind_drone')}</span>}
            <Dialog.Close asChild><button type="button" className="btn px-2 py-1" aria-label={t('common.close')} data-testid="viewer-close"><X size={14} aria-hidden /></button></Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{t('media.viewer_desc')}</Dialog.Description>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex h-[min(62vh,560px)] items-center justify-center overflow-hidden rounded bg-card2" data-testid="viewer-stage">
              {video ? <video src={it.download_url} controls className="h-full w-full" data-testid="viewer-video" />
                : pano && src ? <PanoramaView src={src} label={typeName} />
                  : src ? <img src={src} alt={typeName} className="max-h-full max-w-full object-contain" data-testid="viewer-image" />
                    : <p className="text-sm text-mute" data-testid="viewer-loading">{original.isError ? t('media.viewer_failed') : t('common.loading')}</p>}
            </div>
            <div className="space-y-3 text-sm">
              <dl className="space-y-1" data-testid="viewer-facts">
                {row(t('media.f_site'), site?.code ?? null, 'viewer-site', true)}
                {row(t('media.taken_at'), g?.taken_at ? new Date(g.taken_at).toLocaleString(ar ? 'ar-LY' : 'en-GB') : null, 'viewer-taken')}
                {g && g.lat !== null && g.lon !== null && row(t('media.coords'), `${fmtCoord(g.lat)}, ${fmtCoord(g.lon!)}`, 'viewer-coords', true)}
                {row(t('media.altitude'), g?.altitude_m != null ? `${g.altitude_m} m` : null, 'viewer-alt')}
                {row(t('media.camera'), [g?.make, g?.model].filter(Boolean).join(' ') || null, 'viewer-camera')}
                {row(t('media.size_px'), g?.width_px && g.height_px ? `${g.width_px} x ${g.height_px}` : null, 'viewer-size', true)}
                {g?.source === 'device' && row(t('media.source'), t('media.source_device'), 'viewer-source')}
              </dl>
              {g?.distance_m != null && (
                <p className={`chip ${g.far ? 'bg-lateBg text-lateInk' : 'bg-doneBg text-doneInk'}`} data-testid="viewer-distance" data-far={String(!!g.far)}>
                  {g.far ? t('media.far_from_site', { distance: fmtDistance(g.distance_m) }) : t('media.near_site', { distance: fmtDistance(g.distance_m) })}</p>)}
              {g && g.lat === null && <p className="text-xs text-mute" data-testid="viewer-no-gps">{t('media.no_gps')}</p>}
              {!g && <p className="text-xs text-mute" data-testid="viewer-unscanned">{t('media.unscanned')}</p>}
              {g && g.lat !== null && g.lon !== null && (
                <MediaGeoMap testid="viewer-map" points={[{ id: it.id, lat: g.lat, lon: g.lon, far: g.far, label: typeName, kind: it.media_kind as 'photo', siteId: site?.id ?? null }]}
                  sites={site?.latitude != null && site.longitude != null ? [{ id: site.id, code: site.code ?? '', lat: site.latitude, lon: site.longitude }] : []} />)}
              <div className="flex flex-wrap gap-2">
                {!video && !pano && !full && it.mime_type.startsWith('image/') && <button type="button" className="btn" data-testid="viewer-full" onClick={() => setFull(true)}><Rows3 size={14} aria-hidden /> {t('media.full_size')}</button>}
                <Tip text={t('media.download')}><button type="button" className="btn" data-testid="viewer-download" onClick={() => void downloadFile(it.download_url).catch(() => undefined)}><Download size={14} aria-hidden /> {t('media.download')}</button></Tip>
                {to && <Link to={to} className="btn" data-testid="viewer-open" onClick={onClose}><ExternalLink size={14} aria-hidden /> {t('media.open_record')}</Link>}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
