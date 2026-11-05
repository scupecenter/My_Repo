import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, ExternalLink, List, Map as MapIcon, Maximize2, Minimize2, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useSiteMap } from '@/api/dashboard';
import { useRegions, useSite, useSiteTasks } from '@/api/sites';
import type { TaskSummary } from '@/api/types';
import { DrawerFrame } from './DrawerFrame';
import { EChart } from './EChart';
import { Holders } from './HolderChip';
import { EmptyState } from './States';
import { QuickFilter } from './TableKit';
import {
  activeCount, applyFilters, buildMapOption, categories, categoryOf, categoryToken, facet, filterParams, lightOf, LIST_KEYS, marks, readFilters, token,
  type ListKey, type MapFilters, type OuterScope, type SiteMapGroup, type SiteMapItem,
} from '@/lib/siteMap';

const STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'];
const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'];
const LIST_LIMIT = 300;
const OPEN_STATES = new Set(['open', 'entry', 'in_review', 'in_approval']);

/** True when the person asked the system for less motion: the lights then do not pulse (a steady halo instead). */
export function useReducedMotion(): boolean {
  const q = '(prefers-reduced-motion: reduce)';
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
  const [v, setV] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(q);
    const on = () => setV(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return v;
}

/** A ClickUp-style filter chip: the label with the chosen values, a pop-over list of options with counts. */
function FilterChip({ id, label, options, value, onChange }: { id: string; label: string; options: { v: string; label: string; n: number }[]; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const on = value.length > 0;
  const shown = options.filter((o) => o.n > 0 || value.includes(o.v));
  const names = value.map((v) => options.find((o) => o.v === v)?.label ?? v);
  return (
    <Popover.Root>
      <span className={`chip gap-1 border ${on ? 'border-accent bg-accentSoft text-accentText' : 'border-line'}`}>
        <Popover.Trigger asChild>
          <button type="button" className="flex items-center gap-1" data-testid={`map-filter-${id}`} aria-label={on ? `${label}: ${names.join(', ')}` : label}>
            <span className="font-semibold">{label}</span>{on && <span className="max-w-40 truncate">: {names.join(', ')}</span>}<ChevronDown size={12} aria-hidden />
          </button>
        </Popover.Trigger>
        {on && <button type="button" aria-label={t('table.remove_filter', { label })} data-testid={`map-filter-${id}-clear`} onClick={() => onChange([])}><X size={12} /></button>}
      </span>
      <Popover.Portal>
        <Popover.Content sideOffset={6} align="start" className="card z-[70] max-h-80 w-64 overflow-auto p-2 text-sm" data-testid={`map-filter-${id}-menu`}>
          {shown.length === 0 && <p className="p-2 text-mute">{t('siteMap.no_options')}</p>}
          {shown.map((o) => (
            <label key={o.v} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-hover">
              <input type="checkbox" data-testid={`map-opt-${id}-${o.v || 'none'}`} checked={value.includes(o.v)}
                onChange={(e) => onChange(e.target.checked ? [...value, o.v] : value.filter((x) => x !== o.v))} />
              <span className="flex-1 truncate">{o.label}</span><span className="tnum text-mute">{o.n}</span>
            </label>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The site map (OV-12 on the dashboard, SC-10 in the Site Register; owner request 2026-11-05). Each site with valid coordinates is a small tower with a
 * light on top: the colour of its current stream (or milestone), pulsing while in progress; steady green once On-Air is reached; amber on hold; grey not
 * started; dark grey cancelled (only when the status filter asks). A red ring marks a late site. Drawn by ECharts on a bundled outline of Libya: no tiles,
 * nothing is fetched from outside the server. Filters live in the URL (prefix map_); a site card opens in the drawer.
 */
export function SiteMap({ outer: outerIn, height = 460, testid = 'site-map' }: { outer?: OuterScope; height?: number; testid?: string }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [sp, setSp] = useSearchParams();
  // stable while the URL and the outer scope do not change, so a re-render (the drawer, a refetch) keeps the pan and zoom of the map
  const fKey = sp.toString();
  const f = useMemo(() => readFilters(new URLSearchParams(fKey)), [fKey]);
  const outerKey = JSON.stringify(outerIn ?? {});
  const outer = useMemo(() => JSON.parse(outerKey) as OuterScope, [outerKey]);
  const q = useSiteMap();
  const regions = useRegions();
  const reduced = useReducedMotion();
  const [full, setFull] = useState(false);
  const [layout, setLayout] = useState<'map' | 'list'>('map');
  const [viewKey, setViewKey] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data;
  const items = useMemo(() => d?.items ?? [], [d]);
  const set = useCallback((patch: Partial<MapFilters>) => setSp((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(filterParams(patch))) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  }, { replace: true }), [setSp]);

  useEffect(() => {
    if (!full) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !open) setFull(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [full, open]);

  const groupName = (g: SiteMapGroup | undefined, code: string, kind: 'stream' | 'stage') =>
    g ? (ar && g.name_ar) || g.name_en : code ? t(`${kind}.${code}`, { defaultValue: code }) : t('siteMap.none');
  const streamName = (code: string) => groupName(d?.streams.find((s) => s.code === code), code, 'stream');
  const msName = (code: string) => groupName(d?.milestones.find((s) => s.code === code), code, 'stage');
  const regionName = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (ar && r?.name_ar) || r?.name_en || String(id); };
  const catLabel = (c: string) => (c.startsWith('stream:') ? streamName(c.slice(7)) : c.startsWith('ms:') ? msName(c.slice(3)) : t(`siteMap.light.${c}`));

  const shown = useMemo(() => applyFilters(items, f, outer), [items, f, outer]);
  const visible = useMemo(() => shown.filter((s) => !f.hide.includes(categoryOf(s, f.by))), [shown, f.hide, f.by]);
  const cats = d ? categories(f.by, d, f.status.includes('cancelled')) : [];
  const drawn = shown.filter((s) => s.has_coordinates);
  const countOf = (c: string) => drawn.filter((s) => categoryOf(s, f.by) === c).length;
  const noCoords = shown.filter((s) => !s.has_coordinates && s.overall_status !== 'cancelled').length;
  const ms = useMemo(() => (d ? marks(visible, { by: f.by, streams: d.streams, milestones: d.milestones, reducedMotion: reduced }) : []), [d, visible, f.by, reduced]);

  const tip = useCallback((s: SiteMapItem) => [
    `${s.site_code} · ${(ar && s.name_ar) || s.name}`,
    `${t(`status.${s.overall_status}`)}${s.stream_code ? ` · ${streamName(s.stream_code)}` : ''}${s.milestone_code ? ` · ${msName(s.milestone_code)}` : ''}`,
    ...(s.on_air_reached ? [t('siteMap.light.on_air')] : []),
    ...(s.late ? [t('siteMap.late_tip', { n: s.late_task_count })] : []),
  ].join('\n'), [ar, t, d]); // eslint-disable-line react-hooks/exhaustive-deps -- names come from d
  const build = useMemo(() => (_p: unknown, rtl: boolean) => (d ? buildMapOption(ms, {
    by: f.by, streams: d.streams, milestones: d.milestones, reducedMotion: reduced, rtl, tip, cityName: (k) => t(`siteMap.city.${k}`),
  }) : {}), [ms, d, f.by, reduced, tip, t, viewKey]); // eslint-disable-line react-hooks/exhaustive-deps -- viewKey resets the pan and zoom

  if (q.isError) {
    const status = (q.error as { status?: number } | null)?.status;
    return <section className="card p-4" data-testid={testid}><h2 className="mb-2 font-bold">{t('siteMap.title')}</h2><EmptyState testid={`${testid}-error`} title={status === 403 ? t('siteMap.forbidden') : t('dash.error')} /></section>;
  }

  const opts = (key: ListKey): { v: string; label: string; n: number }[] => {
    const counts = d ? facet(items, f, outer, key) : new Map<string, number>();
    const n = (v: string) => counts.get(v) ?? 0;
    const fromData = (vals: string[], label: (v: string) => string) => [...new Set(vals)].sort((a, b) => label(a).localeCompare(label(b))).map((v) => ({ v, label: label(v), n: n(v) }));
    switch (key) {
      case 'status': return STATUSES.map((v) => ({ v, label: t(`status.${v}`), n: n(v) }));
      case 'region': return [...new Set(items.map((s) => s.region_id))].sort((a, b) => a - b).map((r) => ({ v: String(r), label: regionName(r), n: n(String(r)) }));
      case 'scenario': return SCENARIOS.map((v) => ({ v, label: t(`scenario.${v}`), n: n(v) }));
      case 'stream': return [...(d?.streams ?? []).map((s) => ({ v: s.code, label: streamName(s.code), n: n(s.code) })), { v: '', label: t('siteMap.none'), n: n('') }];
      case 'ms': return [...(d?.milestones ?? []).map((m) => ({ v: m.code, label: msName(m.code), n: n(m.code) })), { v: '', label: t('siteMap.none'), n: n('') }];
      case 'sub': return fromData(items.map((s) => s.sub_region ?? ''), (v) => v || t('siteMap.none'));
      case 'owner': return fromData(items.map((s) => s.tower_owner ?? ''), (v) => v || t('siteMap.none'));
      default: return fromData(items.map((s) => s.cluster_code ?? ''), (v) => v || t('siteMap.none'));
    }
  };
  const nActive = activeCount(f);
  const clear = () => set({ ...Object.fromEntries(LIST_KEYS.map((k) => [k, []])), late: false, q: '', hide: [] } as Partial<MapFilters>);
  const summary = t('siteMap.chart_label', {
    n: ms.length, list: cats.map((c) => `${catLabel(c)} ${countOf(c)}`).join(', '),
  });

  return (
    <section className={full ? 'fixed inset-0 z-[55] overflow-auto bg-bg p-4' : 'card p-4'} data-testid={testid} data-full={full} aria-label={t('siteMap.title')}
      role={full ? 'dialog' : undefined} aria-modal={full || undefined}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-bold">{t('siteMap.title')}</h2>
        <span className="text-sm text-mute" data-testid="map-count">{t('siteMap.count', { shown: drawn.length, total: shown.length })}</span>
        <span className="ms-auto flex flex-wrap items-center gap-1">
          <span role="radiogroup" aria-label={t('siteMap.colour_by')} className="flex items-center gap-1 text-sm">
            <span className="text-mute">{t('siteMap.colour_by')}</span>
            {(['stream', 'milestone'] as const).map((b) => (
              <button key={b} type="button" role="radio" aria-checked={f.by === b} data-testid={`map-by-${b}`} onClick={() => set({ by: b, hide: [] })}
                className={`btn px-2 py-0.5 text-xs ${f.by === b ? 'border-accent bg-accentSoft text-accentText' : ''}`}>{t(`siteMap.by_${b}`)}</button>
            ))}
          </span>
          <button type="button" className="btn px-2 py-1 text-xs" data-testid="map-layout" aria-pressed={layout === 'list'} onClick={() => setLayout(layout === 'map' ? 'list' : 'map')}>
            {layout === 'map' ? <><List size={14} />{t('siteMap.as_list')}</> : <><MapIcon size={14} />{t('siteMap.as_map')}</>}
          </button>
          {layout === 'map' && <button type="button" className="btn px-2 py-1 text-xs" data-testid="map-reset-view" onClick={() => setViewKey((k) => k + 1)}><RotateCcw size={14} />{t('siteMap.reset_view')}</button>}
          <button type="button" className="btn px-2 py-1 text-xs" data-testid="map-full" aria-pressed={full} onClick={() => setFull(!full)}>
            {full ? <><Minimize2 size={14} />{t('siteMap.exit_full')}</> : <><Maximize2 size={14} />{t('siteMap.full')}</>}
          </button>
        </span>
      </div>

      {/* filters (in the URL) */}
      <div role="toolbar" aria-label={t('siteMap.filters')} className="mb-2 flex flex-wrap items-center gap-2" data-testid="map-filters">
        <input className="input w-48 py-1 text-sm" data-testid="map-search" placeholder={t('siteMap.search')} aria-label={t('siteMap.search')} value={f.q} onChange={(e) => set({ q: e.target.value })} />
        {LIST_KEYS.map((k) => <FilterChip key={k} id={k} label={t(`siteMap.f.${k}`)} options={opts(k)} value={f[k]} onChange={(v) => set({ [k]: v } as Partial<MapFilters>)} />)}
        <QuickFilter testid="map-late" on={f.late} onClick={() => set({ late: !f.late })}>{t('siteMap.late_only')}</QuickFilter>
        {nActive > 0 && <button type="button" className="btn px-2 py-0.5 text-xs" data-testid="map-clear" onClick={clear}>{t('states.clear_filters')}</button>}
      </div>
      {(outer.region_id || outer.cluster_code || outer.scenario || outer.stream) && <p className="mb-2 text-xs text-mute" data-testid="map-outer">{t('siteMap.outer_note')}</p>}

      {/* legend: counts per colour, a click hides or shows the colour */}
      <div className="mb-2 flex flex-wrap gap-1" data-testid="map-legend" aria-label={t('siteMap.legend')}>
        {cats.map((c) => {
          const off = f.hide.includes(c);
          const pulse = c.includes(':') && !reduced;
          return (
            <button key={c} type="button" aria-pressed={!off} data-testid={`map-legend-${c}`} data-pulse={pulse}
              onClick={() => set({ hide: off ? f.hide.filter((x) => x !== c) : [...f.hide, c] })}
              className={`chip gap-1 border border-line text-xs ${off ? 'opacity-50 line-through' : ''}`}>
              <span className="relative inline-flex h-2.5 w-2.5" aria-hidden>
                {pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: token(categoryToken(c, d?.streams ?? [], d?.milestones ?? [])) }} />}
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: token(categoryToken(c, d?.streams ?? [], d?.milestones ?? [])) }} />
              </span>
              {catLabel(c)} <b className="tnum">{countOf(c)}</b>
            </button>
          );
        })}
        <span className="chip gap-1 border border-line text-xs" data-testid="map-legend-late"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-late" aria-hidden />{t('siteMap.late_ring')}</span>
      </div>

      {q.isLoading ? <div className="animate-pulse rounded bg-lockBg" style={{ height }} data-testid="map-loading" /> : layout === 'map' ? (
        <div className="overflow-hidden rounded border border-line" style={{ background: 'var(--map-sea)' }}>
          <EChart build={build} renderer="canvas" height={full ? 'calc(100vh - 220px)' : height} label={summary} testid="map-chart"
            onClick={(p) => { const id = (p.data as { site?: string } | undefined)?.site; if (id) setOpen(id); }} />
        </div>
      ) : (
        <div className="overflow-auto rounded border border-line" style={{ maxHeight: full ? 'calc(100vh - 220px)' : height }}>
          <table className="w-full text-sm" data-testid="map-list">
            <thead><tr className="text-mute"><th className="px-2 py-1 text-start">{t('sites.code')}</th><th className="px-2 text-start">{t('sites.name')}</th><th className="px-2 text-start">{t('sites.region')}</th>
              <th className="px-2 text-start">{t('siteMap.light_col')}</th><th className="px-2 text-start">{t('siteMap.f.stream')}</th><th className="px-2 text-start">{t('siteMap.f.ms')}</th></tr></thead>
            <tbody>
              {visible.slice(0, LIST_LIMIT).map((s) => {
                const l = lightOf(s);
                return (
                  <tr key={s.id} className="border-t border-line" data-testid={`map-row-${s.site_code}`} data-light={l} data-pulse={l === 'progress' && !reduced} data-late={s.late}>
                    <td className="px-2 py-1"><button type="button" className="mono font-semibold text-link hover:underline" data-testid={`map-open-${s.site_code}`} onClick={() => setOpen(s.id)}>{s.site_code}</button></td>
                    <td className="px-2">{(ar && s.name_ar) || s.name}</td>
                    <td className="px-2">{regionName(s.region_id)}</td>
                    <td className="px-2"><span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: token(categoryToken(categoryOf(s, f.by), d?.streams ?? [], d?.milestones ?? [])), outline: s.late ? '2px solid var(--late)' : undefined }} aria-hidden />{t(`siteMap.light.${l}`)}</span></td>
                    <td className="px-2">{s.stream_code ? streamName(s.stream_code) : '—'}</td>
                    <td className="px-2">{s.milestone_code ? msName(s.milestone_code) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length > LIST_LIMIT && <p className="p-2 text-xs text-mute">{t('siteMap.list_limit', { n: LIST_LIMIT, total: visible.length })}</p>}
          {visible.length === 0 && <p className="p-3 text-sm text-mute" data-testid="map-list-empty">{t('siteMap.empty')}</p>}
        </div>
      )}

      <p className="mt-2 text-sm text-mute" data-testid="map-no-coords">
        {noCoords > 0
          ? <Link className="text-link hover:underline" to="/sites?coordinates=missing" data-testid="map-no-coords-link">{t('siteMap.no_coords', { count: noCoords })}</Link>
          : t('siteMap.all_coords')}
        {' · '}{t('siteMap.offline_note')}
      </p>

      <DrawerFrame name="site-map" testid="map-drawer" open={!!open} onClose={() => setOpen(null)} wide={440}>
        {open && <SiteCard item={items.find((s) => s.id === open)} id={open} streamName={streamName} msName={msName} regionName={regionName} />}
      </DrawerFrame>
    </section>
  );
}

/** The site card of the map: the map row plus the site detail (names, coordinates, tower) and the current task with its holder. Only what the caller may see. */
function SiteCard({ item, id, streamName, msName, regionName }: { item?: SiteMapItem; id: string; streamName: (c: string) => string; msName: (c: string) => string; regionName: (id: number) => string }) {
  const { t, i18n } = useTranslation();
  const site = useSite(id);
  const s = site.data;
  const tasks = useSiteTasks(id, item?.stream_code ?? null, !!item?.milestone_code);
  const current: TaskSummary | undefined = tasks.data?.stages.find((st) => st.code === item?.milestone_code)?.tasks.find((x) => OPEN_STATES.has(x.state));
  const reached = (s?.pipeline ?? []).filter((n) => n.kind === 'milestone' && n.state === 'done' && n.actual_date);
  const row = (k: string, label: string, v: ReactNode) => (
    <div className="grid grid-cols-[40%_60%] gap-2 border-b border-line py-1 text-sm" data-testid={`card-${k}`}><dt className="text-mute">{label}</dt><dd className="min-w-0 break-words">{v ?? '—'}</dd></div>
  );
  const dash = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);
  if (!item) return <div className="p-4"><EmptyState title={t('siteMap.gone')} /></div>;
  const l = lightOf(item);
  return (
    <div className="h-full overflow-auto p-4" data-testid="map-card" data-light={l}>
      <h2 className="text-lg font-bold"><span className="mono">{item.site_code}</span> · {item.name}</h2>
      {item.name_ar && <p dir="rtl" lang="ar" className="text-mute" data-testid="card-name-ar">{item.name_ar}</p>}
      <p className="mb-3 mt-1 flex flex-wrap gap-1">
        <span className="chip border border-line" data-testid="card-light">{t(`siteMap.light.${l}`)}</span>
        {item.late && <span className="chip bg-lateBg text-lateInk" data-testid="card-late">{t('siteMap.late_tip', { n: item.late_task_count })}{item.behind_baseline ? ` · ${t('siteMap.behind')}` : ''}</span>}
      </p>
      <dl>
        {row('region', t('sites.region'), regionName(item.region_id))}
        {row('sub', t('siteMap.f.sub'), dash(item.sub_region))}
        {row('cluster', t('siteMap.f.cluster'), dash(item.cluster_code))}
        {row('coords', t('siteMap.coords'), item.latitude !== null && item.longitude !== null ? <span className="mono" dir="ltr">{item.latitude.toFixed(5)}, {item.longitude.toFixed(5)}</span> : '—')}
        {row('scenario', t('siteMap.f.scenario'), item.delivery_scenario ? t(`scenario.${item.delivery_scenario}`) : '—')}
        {row('status', t('siteMap.f.status'), t(`status.${item.overall_status}`))}
        {row('owner', t('siteMap.f.owner'), dash(item.tower_owner))}
        {s && (s.tower_type || s.tower_height_m !== null && s.tower_height_m !== undefined) && row('tower', t('siteMap.tower'), [s.tower_type, s.tower_height_m != null ? `${s.tower_height_m} m` : null].filter(Boolean).join(' · '))}
        {s && row('owner_site_id', t('siteMap.owner_site_id'), dash(s.owner_site_id))}
        {row('stream', t('siteMap.f.stream'), item.stream_code ? streamName(item.stream_code) : '—')}
        {row('ms', t('siteMap.f.ms'), item.milestone_code ? msName(item.milestone_code) : '—')}
        {item.milestone_code && row('task', t('siteMap.current_task'), tasks.isLoading ? t('common.loading') : current
          ? <span className="flex flex-col gap-1"><span><span className="mono">{current.task_code}</span> · {(i18n.language === 'ar' && current.name_ar) || current.name_en}</span>
            <Holders holders={current.ball_in_court?.holders ?? []} /></span>
          : '—')}
        {row('late_n', t('siteMap.late_tasks'), item.late_task_count)}
        {row('progress', t('siteMap.task_progress'), item.task_progress_pct === null ? '—' : `${item.task_progress_pct}%`)}
      </dl>
      <h3 className="mb-1 mt-3 font-semibold">{t('siteMap.reached')}</h3>
      {site.isLoading ? <p className="text-sm text-mute">{t('common.loading')}</p> : reached.length ? (
        <ul className="text-sm" data-testid="card-reached">
          {reached.map((n) => <li key={n.code} className="flex justify-between border-b border-line py-0.5"><span>{(i18n.language === 'ar' && n.name_ar) || n.name_en}</span><span className="mono">{n.actual_date}</span></li>)}
        </ul>
      ) : <p className="text-sm text-mute">—</p>}
      <Link className="btn btn-primary mt-4" to={`/sites/${id}`} data-testid="card-open-site"><ExternalLink size={14} />{t('siteMap.open_site')}</Link>
    </div>
  );
}
