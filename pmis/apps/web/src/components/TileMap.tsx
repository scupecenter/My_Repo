import { Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UiMap } from '@/api/mapSettings';
import type { MapMark } from '@/lib/siteMap';
import { fitView, pan, toScreen, tileUrl, visibleTiles, zoomAt, type Size, type View } from '@/lib/tileMap';

/**
 * The site map on real tiles (field mode phase 2, migration 0412): square tiles from the admin's same-origin template, the sites as pins on top. No library.
 * Drag to pan, wheel or the + / - buttons to zoom, arrow keys and + / - on the focused map. A pin opens the same site drawer as the outline map.
 * `resetKey` refits the view to the pins (the "Reset view" button of the toolbar).
 */
export function TileMap({ marks, cfg, height, label, resetKey, tip, onOpen, testid = 'tile-map' }: {
  marks: MapMark[]; cfg: UiMap; height: number | string; label: string; resetKey: number; tip: (m: MapMark) => string; onOpen: (siteId: string) => void; testid?: string;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 800, height: 520 });
  const start = useMemo<View>(() => ({ lat: cfg.center_lat, lon: cfg.center_lon, zoom: cfg.default_zoom }), [cfg.center_lat, cfg.center_lon, cfg.default_zoom]);
  const points = useMemo(() => marks.map((m) => ({ lat: m.site.latitude as number, lon: m.site.longitude as number })), [marks]);
  const [view, setView] = useState<View>(start);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [failed, setFailed] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth || 800, height: el.clientHeight || 520 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // fit the pins on opening, when the set of pins or the limits change, and on "Reset view"
  const pointsKey = points.map((p) => `${p.lat},${p.lon}`).join('|');
  const fitKey = `${pointsKey}#${resetKey}#${cfg.min_zoom}#${cfg.max_zoom}`;
  const [lastFit, setLastFit] = useState('');
  if (lastFit !== fitKey) { // derived during render: re-fit once per change of the pins or limits, never on resize while panning
    setLastFit(fitKey);
    setView(fitView(points, size, start, cfg.min_zoom, cfg.max_zoom));
  }

  const tiles = useMemo(() => visibleTiles(view, size), [view, size]);
  const zoom = (d: number, px?: number, py?: number) => setView((v) => zoomAt(v, d, cfg.min_zoom, cfg.max_zoom, size, px, py));
  const key = (e: React.KeyboardEvent) => {
    const step = 80;
    if (e.key === 'ArrowLeft') setView((v) => pan(v, step, 0));
    else if (e.key === 'ArrowRight') setView((v) => pan(v, -step, 0));
    else if (e.key === 'ArrowUp') setView((v) => pan(v, 0, step));
    else if (e.key === 'ArrowDown') setView((v) => pan(v, 0, -step));
    else if (e.key === '+' || e.key === '=') zoom(1);
    else if (e.key === '-') zoom(-1);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={box} className="relative select-none overflow-hidden bg-lockBg" style={{ height, touchAction: 'none' }} data-testid={testid} role="application" aria-label={label} tabIndex={0}
      onKeyDown={key}
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }}
      onPointerMove={(e) => {
        const d = drag.current; if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
        d.x = e.clientX; d.y = e.clientY;
        setView((v) => pan(v, dx, dy));
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onWheel={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); zoom(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top); }}>
      {tiles.map((tl) => (
        <img key={`${tl.z}/${tl.x}/${tl.y}/${tl.left}`} src={tileUrl(cfg.tile_url, tl)} alt="" draggable={false} loading="lazy" width={256} height={256} data-testid="tile"
          onError={() => setFailed((n) => n + 1)} className="pointer-events-none absolute max-w-none" style={{ left: tl.left, top: tl.top }} />
      ))}
      {marks.map((m) => {
        const p = toScreen(m.site.latitude as number, m.site.longitude as number, view, size);
        if (p.x < -20 || p.y < -20 || p.x > size.width + 20 || p.y > size.height + 20) return null;
        return (
          <button key={m.site.id} type="button" data-testid={`tile-pin-${m.site.site_code}`} title={tip(m)} aria-label={m.site.site_code}
            onClick={(e) => { e.stopPropagation(); onOpen(m.site.id); }} onPointerDown={(e) => e.stopPropagation()}
            className={`absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${m.site.late ? 'border-late' : 'border-white'} shadow`}
            style={{ left: p.x, top: p.y, background: m.colour }} />
        );
      })}
      <div className="absolute end-2 top-2 flex flex-col gap-1" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="btn px-2 py-1" aria-label={t('tileMap.zoom_in')} data-testid="tile-zoom-in" disabled={view.zoom >= cfg.max_zoom} onClick={() => zoom(1)}><Plus size={14} /></button>
        <button type="button" className="btn px-2 py-1" aria-label={t('tileMap.zoom_out')} data-testid="tile-zoom-out" disabled={view.zoom <= cfg.min_zoom} onClick={() => zoom(-1)}><Minus size={14} /></button>
      </div>
      {failed > 0 && tiles.length > 0 && failed >= tiles.length && <p role="status" data-testid="tile-missing" className="absolute start-2 top-2 rounded bg-waitBg px-2 py-1 text-xs text-waitInk">{t('tileMap.missing')}</p>}
      {cfg.attribution && <p className="absolute bottom-0 end-0 rounded-ss bg-white/80 px-1.5 py-0.5 text-[10px] text-ink" data-testid="tile-attribution">{cfg.attribution}</p>}
    </div>
  );
}
