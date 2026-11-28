import { CalendarDays, Download, Expand, ExternalLink, FileImage, FileText, Grid3x3, List, Map as MapIcon, MapPin, Plane, RotateCw, Settings2, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { downloadFile } from '@/api/client';
import { EMPTY_MEDIA_FILTER, mediaLinkTo, useMediaFacets, useMediaItems, useMediaThumb, type MediaFilter, type MediaItem, type MediaSite } from '@/api/media';
import { DateInput } from '@/components/DateInput';
import { LayoutPanel, type ViewOption } from '@/components/LayoutPanel';
import { MediaGeoMap, type GeoPoint, type GeoSite } from '@/components/MediaGeoMap';
import { fmtDistance, MediaViewer } from '@/components/MediaViewer';
import { PageHeader } from '@/components/PageHeader';
import { SavedViews } from '@/components/SavedViews';
import { EmptyState, QueryFallback } from '@/components/States';
import { SearchBox, TableToolbar } from '@/components/TableStandard';
import { Tip } from '@/components/Tip';
import { useRememberedView } from '@/lib/viewPreference';
import { LibraryTabs } from './LibraryTabs';

/** View modes of the gallery (kept per user through the shared remembered-view store, screen key library-media). */
const MODES = ['grid', 'list', 'site', 'date', 'map'] as const;
type Mode = (typeof MODES)[number];
const isMode = (v: string): v is Mode => (MODES as readonly string[]).includes(v);

const KEYS = Object.keys(EMPTY_MEDIA_FILTER) as (keyof MediaFilter)[];

/** What the geotag says about an item, as small chips: a far-from-site warning, the panorama and drone kinds, and (when the setting asks) a missing location. */
function GeoChips({ it }: { it: MediaItem }) {
  const { t } = useTranslation();
  const g = it.geo;
  return (
    <>
      {it.media_kind === 'panorama' && <span className="chip bg-accentSoft text-accentText" data-testid="media-kind" data-media-kind="panorama"><RotateCw size={11} aria-hidden /> {t('media.kind_panorama')}</span>}
      {it.media_kind === 'drone' && <span className="chip bg-accentSoft text-accentText" data-testid="media-kind" data-media-kind="drone"><Plane size={11} aria-hidden /> {t('media.kind_drone')}</span>}
      {g?.far && g.distance_m != null && <span className="chip bg-lateBg text-lateInk" data-testid="media-far" title={t('media.far_from_site', { distance: fmtDistance(g.distance_m) })}><TriangleAlert size={11} aria-hidden /> {fmtDistance(g.distance_m)}</span>}
    </>
  );
}

function Card({ it, ar, onOpen }: { it: MediaItem; ar: boolean; onOpen: (it: MediaItem) => void }) {
  const { t } = useTranslation();
  const th = useMediaThumb(it, 'small');
  const to = mediaLinkTo(it.link as Record<string, unknown>);
  const typeName = (ar && it.type.name_ar) || it.type.name_en;
  const site = it.site as { code?: string } | null;
  const dl = () => void downloadFile(it.download_url).catch(() => undefined);
  return (
    <li className={`card overflow-hidden ${it.state === 'current' ? '' : 'opacity-70'}`} data-testid={`media-card-${it.id}`} data-kind={it.kind} data-state={it.state}>
      <button type="button" className="flex aspect-[4/3] w-full items-center justify-center bg-card2" aria-label={t('media.view')} data-testid="media-thumb-open" onClick={() => onOpen(it)}>
        {th.data ? <img src={th.data} alt={typeName} loading="lazy" className="h-full w-full object-cover" data-testid="media-thumb" />
          : it.mime_type.startsWith('image/') ? <FileImage size={36} className="text-mute" aria-hidden /> : <FileText size={36} className="text-mute" aria-hidden />}
      </button>
      <div className="space-y-1 p-2 text-xs">
        <p className="truncate font-semibold" title={typeName}>{typeName}</p>
        <p className="flex flex-wrap items-center gap-1 text-mute">
          {site?.code && <span className="mono">{site.code}</span>}
          <span>{new Date(it.uploaded_at).toLocaleDateString(ar ? 'ar-LY' : 'en-GB')}</span>
          {it.state !== 'current' && <span className="chip bg-lockBg text-lockInk" data-testid="media-state">{t(`media.state_${it.state}`)}</span>}
          <GeoChips it={it} />
        </p>
        <div className="flex items-center gap-1 pt-1">
          <Tip text={t('media.view')}><button type="button" className="btn px-2 py-1" aria-label={t('media.view')} data-testid="media-viewer-open" onClick={() => onOpen(it)}><Expand size={14} aria-hidden /></button></Tip>
          {to && <Tip text={t('media.open_record')}><Link to={to} className="btn px-2 py-1" aria-label={t('media.open_record')} data-testid="media-open"><ExternalLink size={14} aria-hidden /></Link></Tip>}
          <Tip text={t('media.download')}><button type="button" className="btn px-2 py-1" aria-label={t('media.download')} data-testid="media-download" onClick={dl}><Download size={14} aria-hidden /></button></Tip>
        </div>
      </div>
    </li>
  );
}


function Row({ it, ar, onOpen }: { it: MediaItem; ar: boolean; onOpen: (it: MediaItem) => void }) {
  const { t } = useTranslation();
  const th = useMediaThumb(it, 'small');
  const to = mediaLinkTo(it.link as Record<string, unknown>);
  const typeName = (ar && it.type.name_ar) || it.type.name_en;
  const site = it.site as { code?: string } | null;
  const dl = () => void downloadFile(it.download_url).catch(() => undefined);
  return (
    <li className={`card flex items-center gap-3 p-2 text-sm ${it.state === 'current' ? '' : 'opacity-70'}`} data-testid={`media-row-${it.id}`} data-kind={it.kind} data-state={it.state}>
      <span className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-card2">
        {th.data ? <img src={th.data} alt={typeName} loading="lazy" className="h-full w-full object-cover" /> : <FileImage size={22} className="text-mute" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold" title={typeName}>{typeName}</span>
      <span className="mono w-28 truncate text-mute">{site?.code ?? ''}</span>
      <span className="w-28 text-mute">{new Date(it.uploaded_at).toLocaleDateString(ar ? 'ar-LY' : 'en-GB')}</span>
      <span className="flex w-32 flex-wrap gap-1">{it.state !== 'current' && <span className="chip bg-lockBg text-lockInk" data-testid="media-state">{t(`media.state_${it.state}`)}</span>}<GeoChips it={it} /></span>
      <span className="flex items-center gap-1">
        <Tip text={t('media.view')}><button type="button" className="btn px-2 py-1" aria-label={t('media.view')} data-testid="media-viewer-open" onClick={() => onOpen(it)}><Expand size={14} aria-hidden /></button></Tip>
        {to && <Tip text={t('media.open_record')}><Link to={to} className="btn px-2 py-1" aria-label={t('media.open_record')} data-testid="media-open"><ExternalLink size={14} aria-hidden /></Link></Tip>}
        <Tip text={t('media.download')}><button type="button" className="btn px-2 py-1" aria-label={t('media.download')} data-testid="media-download" onClick={dl}><Download size={14} aria-hidden /></button></Tip>
      </span>
    </li>
  );
}

/** Groups for the by-site and by-date modes; the order of the loaded items is kept inside a group. */
function groupItems(items: MediaItem[], mode: 'site' | 'date', none: string): { key: string; label: string; items: MediaItem[] }[] {
  const m = new Map<string, MediaItem[]>();
  for (const it of items) {
    const k = mode === 'site' ? ((it.site as { code?: string } | null)?.code ?? '') : it.uploaded_at.slice(0, 10);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return [...m.entries()].sort((a, b) => (mode === 'date' ? b[0].localeCompare(a[0]) : (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0]))))
    .map(([key, v]) => ({ key, label: key || none, items: v }));
}

/** The photos of the loaded pages that have a point, with the sites they belong to, for the map mode. */
function mapData(items: MediaItem[], label: (it: MediaItem) => string): { points: GeoPoint[]; sites: GeoSite[] } {
  const points: GeoPoint[] = [];
  const sites = new Map<string, GeoSite>();
  for (const it of items) {
    const site = it.site as MediaSite | null;
    if (site?.latitude != null && site.longitude != null && !sites.has(site.id)) sites.set(site.id, { id: site.id, code: site.code ?? '', lat: site.latitude, lon: site.longitude });
    if (it.geo && it.geo.lat !== null && it.geo.lon !== null) points.push({ id: it.id, lat: it.geo.lat, lon: it.geo.lon, far: it.geo.far, label: label(it), kind: it.media_kind as GeoPoint['kind'], siteId: site?.id ?? null });
  }
  return { points, sites: [...sites.values()] };
}

function MapMode({ items, ar, onPick }: { items: MediaItem[]; ar: boolean; onPick: (id: string) => void }) {
  const { t } = useTranslation();
  const { points, sites } = mapData(items, (it) => ((ar && it.type.name_ar) || it.type.name_en));
  return (
    <div className="space-y-2" data-testid="media-by-map">
      <p className="text-xs text-mute" data-testid="media-map-count">{t('media.map_count', { shown: points.length, total: items.length })}</p>
      <MediaGeoMap points={points} sites={sites} onPick={onPick} />
    </div>
  );
}

/** Library > Media (owner decisions GAL-1 and LIB-1): the images of every enabled source in one gallery, read live from the owning records. */
export function LibraryMedia() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [sp, setSp] = useSearchParams();
  const f = Object.fromEntries(KEYS.map((k) => [k, sp.get(k) ?? ''])) as MediaFilter;
  const set = (p: Partial<MediaFilter>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(p)) { if (v) n.set(k, v); else n.delete(k); } setSp(n, { replace: true }); };
  const q = useMediaItems(f), facets = useMediaFacets();
  const [viewing, setViewing] = useState<MediaItem | null>(null);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const off = q.data?.pages[0] && !q.data.pages[0].enabled;
  const active = KEYS.filter((k) => f[k]).length;
  const mode: Mode = isMode(sp.get('layout') ?? '') ? (sp.get('layout') as Mode) : 'grid';
  const viewOptions: ViewOption[] = [
    { id: 'grid', label: t('media.view_grid'), hint: t('media.view_grid_hint'), icon: <Grid3x3 size={14} />, testid: 'media-layout-grid' },
    { id: 'list', label: t('media.view_list'), hint: t('media.view_list_hint'), icon: <List size={14} />, testid: 'media-layout-list' },
    { id: 'site', label: t('media.view_site'), hint: t('media.view_site_hint'), icon: <MapPin size={14} />, testid: 'media-layout-site' },
    { id: 'date', label: t('media.view_date'), hint: t('media.view_date_hint'), icon: <CalendarDays size={14} />, testid: 'media-layout-date' },
    { id: 'map', label: t('media.view_map'), hint: t('media.view_map_hint'), icon: <MapIcon size={14} />, testid: 'media-layout-map' },
  ];
  const applyView = (id: string) => { const n = new URLSearchParams(sp); if (id === 'grid') n.delete('layout'); else n.set('layout', id); setSp(n, { replace: true }); };
  const remember = useRememberedView('library-media', sp.has('layout'), isMode, applyView);
  const pickView = (id: string) => { applyView(id); remember(id); };
  const gridCls = 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6';
  const body: ReactNode = mode === 'list'
    ? <ul className="space-y-2" data-testid="media-list">{items.map((it) => <Row key={`${it.kind}-${it.id}`} it={it} ar={ar} onOpen={setViewing} />)}</ul>
    : mode === 'map'
      ? <MapMode items={items} ar={ar} onPick={(id) => setViewing(items.find((x) => x.id === id) ?? null)} />
    : mode === 'grid'
      ? <ul className={gridCls} data-testid="media-grid">{items.map((it) => <Card key={`${it.kind}-${it.id}`} it={it} ar={ar} onOpen={setViewing} />)}</ul>
      : <div className="space-y-4" data-testid={`media-by-${mode}`}>{groupItems(items, mode, t('media.group_none')).map((g) => (
        <section key={g.key} aria-label={g.label} data-testid={`media-group-${g.key || 'none'}`}>
          <h3 className="mb-2 text-sm font-semibold"><span className={mode === 'site' ? 'mono' : ''}>{mode === 'date' && g.key ? new Date(g.key).toLocaleDateString(ar ? 'ar-LY' : 'en-GB') : g.label}</span> <span className="text-mute">({g.items.length})</span></h3>
          <ul className={gridCls}>{g.items.map((it) => <Card key={`${it.kind}-${it.id}`} it={it} ar={ar} onOpen={setViewing} />)}</ul>
        </section>))}</div>;
  const sel = (k: keyof MediaFilter, label: string, opts: { v: string; l: string }[]) => (
    <label className="text-xs font-semibold text-mute">{label}
      <select className="input ms-1" data-testid={`media-f-${k}`} value={f[k]} onChange={(e) => set({ [k]: e.target.value })}>
        <option value="">{t('media.all')}</option>{opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>);
  return (
    <div data-testid="page-library-media">
      <PageHeader title={t('media.title')} subtitle={t('media.sub')} context={<Tip text={t('media.settings_link')}><Link className="btn ms-auto px-2 py-1" to="/admin/settings/documents/media" aria-label={t('media.settings_link')} data-testid="media-settings-link"><Settings2 size={15} aria-hidden /></Link></Tip>} />
      <LibraryTabs />
      <TableToolbar testid="media-toolbar" kind="list"
        views={<SavedViews screen="library-media" value={f} empty={EMPTY_MEDIA_FILTER} onApply={(v) => { const x = v as Partial<MediaFilter>; set(Object.fromEntries(KEYS.map((k) => [k, String(x[k] ?? '')])) as Partial<MediaFilter>); }} />}
        search={<SearchBox testid="media-search" value={f.q} onChange={(v) => set({ q: v })} placeholder={t('media.search')} />}
        filter={<span className="flex flex-wrap items-center gap-2">
          {sel('source', t('media.f_source'), [{ v: 'documents', l: t('media.src_documents') }, { v: 'snags', l: t('media.src_snags') }])}
          {sel('doc_code', t('media.f_type'), (facets.data?.document_types ?? []).map((d) => ({ v: d.code, l: `${(ar && d.name_ar) || d.name_en} (${d.count})` })))}
          {sel('snag_type', t('media.f_snag_type'), (facets.data?.snag_types ?? []).map((d) => ({ v: d.code, l: (ar && d.name_ar) || d.name_en })))}
          {sel('geo', t('media.f_geo'), [{ v: 'far', l: t('media.geo_far') }, { v: 'near', l: t('media.geo_near') }, { v: 'has', l: t('media.geo_has') }, { v: 'missing', l: t('media.geo_missing') }, { v: 'unscanned', l: t('media.geo_unscanned') }])}
          {sel('media_kind', t('media.f_kind'), [{ v: 'photo', l: t('media.kind_photo') }, { v: 'panorama', l: t('media.kind_panorama') }, { v: 'drone', l: t('media.kind_drone') }])}
          {sel('status', t('media.f_status'), [{ v: 'pending_evidence', l: t('media.state_pending_evidence') }, { v: 'withdrawn', l: t('media.state_withdrawn') }])}
          <label className="text-xs font-semibold text-mute">{t('media.f_from')}<DateInput className="input ms-1" data-testid="media-f-from" value={f.uploaded_from} onChange={(e) => set({ uploaded_from: e.target.value })} /></label>
          <label className="text-xs font-semibold text-mute">{t('media.f_to')}<DateInput className="input ms-1" data-testid="media-f-to" value={f.uploaded_to} onChange={(e) => set({ uploaded_to: e.target.value })} /></label>
        </span>}
        layout={<LayoutPanel testid="media-view" views={{ value: mode, options: viewOptions, onChange: pickView }} />}
        count={<span className="text-sm text-mute" data-testid="media-count">{t('media.count', { count: items.length })}{active > 0 && <button type="button" className="btn ms-2 px-2 py-0.5 text-xs" data-testid="media-clear" onClick={() => setSp(new URLSearchParams(), { replace: true })}>{t('media.clear')}</button>}</span>} />
      {!q.data ? <QueryFallback queries={[q]} /> : off ? <EmptyState testid="media-off" title={t('media.off')} /> : !items.length ? <EmptyState testid="media-empty" title={t('media.empty')} /> : (
        <>
          {body}
          {viewing && <MediaViewer it={viewing} ar={ar} onClose={() => setViewing(null)} />}
          {q.hasNextPage && <div className="mt-3 text-center"><button type="button" className="btn" data-testid="media-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('media.more')}</button></div>}
        </>
      )}
    </div>
  );
}
