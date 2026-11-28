import { useTranslation } from 'react-i18next';

/**
 * Where photos were taken, drawn from their points: each photo a circle (red when it is far from its site), each site a square, a dashed line from a far
 * photo to its site. A small drawing in a local flat projection (no map service, no tiles): it works offline and shows the relation between the photos and
 * the site, which is what the check needs. Click a circle to pick the photo.
 */
export interface GeoPoint { id: string; lat: number; lon: number; far: boolean | null; label: string; kind: 'photo' | 'panorama' | 'drone'; siteId: string | null }
export interface GeoSite { id: string; code: string; lat: number; lon: number }
const W = 640, H = 380, PAD = 36;

export function MediaGeoMap({ points, sites, onPick, selected, testid = 'media-map' }: { points: GeoPoint[]; sites: GeoSite[]; onPick?: (id: string) => void; selected?: string | null; testid?: string }) {
  const { t } = useTranslation();
  const all = [...points.map((p) => [p.lat, p.lon] as const), ...sites.map((s) => [s.lat, s.lon] as const)];
  if (all.length === 0) return <p className="text-sm text-mute" data-testid={`${testid}-empty`}>{t('media.map_empty')}</p>;
  const lat0 = all.reduce((a, p) => a + p[0], 0) / all.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = all.map((p) => p[1] * k), ys = all.map((p) => p[0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 0.0005);
  const scale = (Math.min(W, H) - 2 * PAD) / span;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const X = (lon: number): number => W / 2 + (lon * k - cx) * scale;
  const Y = (lat: number): number => H / 2 - (lat - cy) * scale;
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const km = (span * 111.32) / 4;
  return (
    <figure className="space-y-1" data-testid={testid}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full rounded border border-line bg-card2" role="img" aria-label={t('media.map_label')}>
        <text x={W - 14} y={20} textAnchor="middle" className="fill-mute text-xs" aria-hidden>N</text>
        <path d={`M${W - 14} 26 l-4 12 h8 z`} className="fill-mute" aria-hidden />
        {points.filter((p) => p.far && p.siteId && siteById.has(p.siteId)).map((p) => {
          const s = siteById.get(p.siteId!)!;
          return <line key={`l-${p.id}`} x1={X(p.lon)} y1={Y(p.lat)} x2={X(s.lon)} y2={Y(s.lat)} strokeDasharray="4 3" className="stroke-lateInk" strokeWidth={1} />;
        })}
        {sites.map((s) => (
          <g key={s.id} data-testid={`${testid}-site-${s.code}`}>
            <rect x={X(s.lon) - 6} y={Y(s.lat) - 6} width={12} height={12} className="fill-accent" />
            <text x={X(s.lon) + 10} y={Y(s.lat) + 4} className="fill-ink text-xs">{s.code}</text>
          </g>
        ))}
        {points.map((p) => (
          <g key={p.id} data-testid={`${testid}-pt-${p.id}`} data-far={p.far === null ? '' : String(p.far)} role={onPick ? 'button' : undefined} tabIndex={onPick ? 0 : undefined}
            aria-label={p.label} className={onPick ? 'cursor-pointer' : undefined} onClick={() => onPick?.(p.id)} onKeyDown={(e) => { if (onPick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPick(p.id); } }}>
            <title>{p.label}</title>
            <circle cx={X(p.lon)} cy={Y(p.lat)} r={p.id === selected ? 9 : 6} className={`${p.far ? 'fill-lateInk' : 'fill-done'} ${p.id === selected ? 'stroke-ink' : 'stroke-card'}`} strokeWidth={2} />
          </g>
        ))}
        <line x1={PAD} y1={H - 14} x2={PAD + km / 111.32 * scale} y2={H - 14} className="stroke-mute" strokeWidth={2} />
        <text x={PAD} y={H - 20} className="fill-mute text-xs">{km >= 1 ? `${km.toFixed(km >= 10 ? 0 : 1)} km` : `${Math.round(km * 1000)} m`}</text>
      </svg>
      <figcaption className="flex flex-wrap items-center gap-3 text-xs text-mute">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 bg-accent" aria-hidden />{t('media.map_site')}</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full bg-done" aria-hidden />{t('media.map_near')}</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full bg-lateInk" aria-hidden />{t('media.map_far')}</span>
      </figcaption>
    </figure>
  );
}
