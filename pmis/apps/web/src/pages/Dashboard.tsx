import { Download, PencilLine, RotateCcw } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { downloadDashboard, useDashboard, type Dashboard as Dash, type DashboardQuery, type ExportFormat } from '@/api/dashboard';
import type { PipelineNode } from '@/api/types';
import { EChart, type Palette } from '@/components/EChart';
import { errText } from '@/components/FormDialog';
import { Pipeline } from '@/components/Pipeline';
import { SiteMap } from '@/components/SiteMap';
import { EmptyState } from '@/components/States';
import { useToast } from '@/components/Toast';
import { streamName } from '@/lib/streams';
import { tripoliToday } from '@/lib/today';

type DashMilestone = Dash['pipeline']['nodes'][number];
const STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'] as const;
const STATUS_TONE: Record<string, string> = { completed: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', on_hold: 'bg-waitBg text-waitInk', not_started: 'bg-lockBg text-lockInk', cancelled: 'bg-lateBg text-lateInk' };
const BAND_TONE: Record<string, string> = { green: 'bg-doneBg text-doneInk', amber: 'bg-waitBg text-waitInk', red: 'bg-lateBg text-lateInk' };
const FONT = 'Cairo, system-ui, sans-serif';

const pct = (n: number | null | undefined, digits = 1): string => (n === null || n === undefined ? '–' : `${Number(n.toFixed(digits))}%`);
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

function Card({ title, testid, children, aside, className = '' }: { title: string; testid: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={`card p-4 ${className}`} data-testid={testid} aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold">{title}</h2>{aside}</div>
      {children}
    </section>
  );
}

/** A progress bar with an optional tick for the plan. */
function Bar({ value, plan, tone = 'bg-accent' }: { value: number; plan?: number | null; tone?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="relative h-3 w-full rounded-full bg-lockBg" role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <i className={`absolute inset-y-0 start-0 rounded-full ${tone}`} style={{ width: `${v}%` }} />
      {plan !== null && plan !== undefined && <u className="absolute -inset-y-1 border-s-2 border-dashed border-ink no-underline" style={{ insetInlineStart: `${Math.max(0, Math.min(100, plan))}%` }} aria-hidden />}
    </div>
  );
}

function Kpi({ title, value, sub, to, testid, tone }: { title: string; value: ReactNode; sub?: ReactNode; to?: string; testid: string; tone?: string }) {
  const body = (
    <>
      <div className="text-sm text-mute">{title}</div>
      <div className={`text-3xl font-bold tnum ${tone ?? ''}`}>{value}</div>
      {sub && <div className="mt-1 text-sm text-mute">{sub}</div>}
    </>
  );
  return to
    ? <Link to={to} className="card block p-4 transition-transform hover:-translate-y-0.5 hover:border-mute" data-testid={testid}>{body}</Link>
    : <div className="card p-4" data-testid={testid}>{body}</div>;
}

export function Dashboard() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const toast = useToast();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const me = useMe(true);
  const today = tripoliToday();
  const q: DashboardQuery = { ref_date: sp.get('ref_date') ?? '', region_id: sp.get('region_id') ?? '', cluster_code: sp.get('cluster_code') ?? '', scenario: sp.get('scenario') ?? '', stream: sp.get('stream') ?? '', view: sp.get('view') ?? '' };
  const refDate = q.ref_date || today;
  const dash = useDashboard(q);
  const d = dash.data;
  const [exporting, setExporting] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  // Q116: a local preview of the other pipeline style; the style in force is the setting (meta.pipeline_variant)
  const [preview, setPreview] = useState<'A' | 'B' | null>(null);
  const canExport = !!me.data && (!!me.data.is_system_admin || me.data.effective.grants.some((g) => g.module_key === 'dashboard' && (g.action as string) === 'export'));
  const setParam = (kv: Record<string, string>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(kv)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  const activeFilters = ['region_id', 'cluster_code', 'scenario', 'stream', 'view'].filter((k) => sp.get(k)).length + (q.ref_date ? 1 : 0);
  const name = (x: { name_en: string; name_ar?: string | null }) => (ar && x.name_ar ? x.name_ar : x.name_en);

  /** Link to the Site Register with the filters of this view and the given ones (the register reads region_id, scenario, overall_status, stage_code, bucket and stream). */
  const sites = (extra: Record<string, string> = {}): string => {
    const p = new URLSearchParams();
    for (const k of ['region_id', 'scenario', 'stream', 'view'] as const) if (q[k]) p.set(k, q[k] as string);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    const s = p.toString();
    return `/sites${s ? `?${s}` : ''}`;
  };

  const doExport = () => {
    setExporting(true);
    downloadDashboard(q, format).then(() => toast(t('dash.export_done')), (e) => toast(errText(e, t), 'err')).finally(() => setExporting(false));
  };

  // ---- charts (memoised on the data; EChart redraws on theme and direction changes)
  const statusRing = useMemo(() => (p: Palette) => ({
    textStyle: { fontFamily: FONT },
    tooltip: { trigger: 'item' },
    series: [{
      type: 'pie', radius: ['58%', '82%'], avoidLabelOverlap: true, label: { show: false }, itemStyle: { borderColor: p.card, borderWidth: 2 },
      data: STATUSES.filter((s) => s !== 'cancelled').map((s) => ({
        name: t(`status.${s}`), value: d?.headline.by_overall_status[s] ?? 0,
        itemStyle: { color: { completed: p.done, in_progress: p.open, on_hold: p.wait, not_started: p.lock }[s] },
      })),
    }],
  }), [d, t]);

  const streamBars = useMemo(() => (p: Palette, rtl: boolean) => {
    const items = d?.streams.items ?? [];
    const s = (key: string, color: string, f: (c: DashStream) => number) => ({ name: t(`dash.streams.${key}`), type: 'bar', stack: 'n', itemStyle: { color }, emphasis: { focus: 'series' }, data: items.map((x) => f(x.counts)) });
    return {
      textStyle: { fontFamily: FONT }, aria: { enabled: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } }, legend: { top: 0, textStyle: { color: p.mute } },
      grid: { left: 16, right: 16, top: 32, bottom: 8, containLabel: true },
      xAxis: { type: 'value', inverse: rtl, axisLabel: { color: p.mute }, splitLine: { lineStyle: { color: p.line } } },
      yAxis: { type: 'category', inverse: true, position: rtl ? 'right' : 'left', data: items.map((x) => streamName(t, i18n.language, x)), axisLabel: { color: p.ink, align: rtl ? 'left' : 'right', margin: 10 } },
      series: [s('done', p.done, (c) => c.done ?? 0), s('in_progress', p.open, (c) => c.in_progress ?? 0), s('waiting', p.lock, (c) => (c.not_due ?? 0) + (c.not_started ?? 0))],
    };
  }, [d, t, i18n.language]);

  const slaBars = useMemo(() => (p: Palette, rtl: boolean) => {
    const rows = d?.sla.by_stage ?? [];
    const s = (key: string, color: string, f: (r: (typeof rows)[number]) => number) => ({ name: t(`dash.sla.${key}`), type: 'bar', stack: 'n', itemStyle: { color }, data: rows.map(f) });
    return {
      textStyle: { fontFamily: FONT }, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } }, legend: { top: 0, textStyle: { color: p.mute } },
      grid: { left: 8, right: 8, top: 32, bottom: 24, containLabel: true },
      xAxis: { type: 'category', inverse: rtl, data: rows.map((r) => r.stage_code), axisLabel: { color: p.mute } },
      yAxis: { type: 'value', position: rtl ? 'right' : 'left', axisLabel: { color: p.mute }, splitLine: { lineStyle: { color: p.line } } },
      series: [s('on_time', p.done, (r) => r.open_on_time), s('at_risk', p.wait, (r) => r.open_at_risk), s('late', p.late, (r) => r.open_late)],
    };
  }, [d, t]);

  const ownerBars = useMemo(() => (p: Palette, rtl: boolean) => {
    const rows = d?.issues?.by_owner.slice(0, 8) ?? [];
    return {
      textStyle: { fontFamily: FONT }, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 16, right: 24, top: 8, bottom: 8, containLabel: true },
      xAxis: { type: 'value', inverse: rtl, minInterval: 1, axisLabel: { color: p.mute }, splitLine: { lineStyle: { color: p.line } } },
      yAxis: { type: 'category', inverse: true, position: rtl ? 'right' : 'left', data: rows.map((r) => r.owner_name ?? t('dash.issues.no_owner')), axisLabel: { color: p.ink, width: 100, overflow: 'truncate', align: rtl ? 'left' : 'right', margin: 10 } },
      series: [{ type: 'bar', itemStyle: { color: p.open }, data: rows.map((r) => r.count), label: { show: true, position: rtl ? 'left' : 'right', color: p.ink } }],
    };
  }, [d, t]);

  const delayBars = useMemo(() => (p: Palette, rtl: boolean) => {
    const rows = d?.delay.items.slice(0, 8) ?? [];
    const label = (r: DelayItem) => delayName(t, r);
    return {
      textStyle: { fontFamily: FONT }, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 16, right: 24, top: 8, bottom: 8, containLabel: true },
      xAxis: { type: 'value', inverse: rtl, axisLabel: { color: p.mute }, splitLine: { lineStyle: { color: p.line } } },
      yAxis: { type: 'category', inverse: true, position: rtl ? 'right' : 'left', data: rows.map(label), axisLabel: { color: p.ink, width: 110, overflow: 'truncate', align: rtl ? 'left' : 'right', margin: 10 } },
      series: [{ type: 'bar', itemStyle: { color: p.late }, data: rows.map((r) => r.late_working_days) }],
    };
  }, [d, t]);

  const gauge = useMemo(() => (p: Palette) => {
    const h = d?.health;
    const band = h?.bands ?? { green: 85, amber: 70 };
    return {
      textStyle: { fontFamily: FONT },
      series: [{
        type: 'gauge', min: 0, max: 100, radius: '95%', startAngle: 200, endAngle: -20, pointer: { show: true, length: '60%', width: 4 },
        axisLine: { lineStyle: { width: 12, color: [[band.amber / 100, p.late], [band.green / 100, p.wait], [1, p.done]] } },
        axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
        detail: { valueAnimation: false, formatter: (v: number) => (h?.score === null || h?.score === undefined ? '–' : `${Math.round(v)}`), fontSize: 26, fontWeight: 700, color: p.ink, offsetCenter: [0, '55%'] },
        data: [{ value: h?.score ?? 0 }],
      }],
    };
  }, [d]);

  const delayLabel = (r: DelayItem): string => delayName(t, r);

  if (dash.isError && !d) {
    return (
      <div data-testid="page-dashboard">
        <h1 className="mb-3 text-2xl font-bold">{t('dash.title')}</h1>
        <EmptyState title={dash.error instanceof Error && 'status' in dash.error && (dash.error as { status: number }).status === 403 ? t('dash.forbidden') : t('dash.error')}
          action={<button className="btn" data-testid="dash-retry" onClick={() => void dash.refetch()}>{t('errors.retry')}</button>} />
      </div>
    );
  }

  const nodes: PipelineNode[] = (d?.pipeline.nodes ?? []).map((m) => ({
    code: m.code, kind: 'milestone', name_en: m.name_en, name_ar: m.name_ar,
    state: m.sites_total === 0 ? 'na' : m.completed >= m.sites_total ? 'done' : (m.late ?? 0) > 0 ? 'late' : m.completed > 0 || m.in_progress > 0 || (m.blocked ?? 0) > 0 ? 'current' : 'planned',
    progress: m.sites_total > 0 ? m.completed / m.sites_total : 0,
  }));
  const byCode = new Map<string, DashMilestone>((d?.pipeline.nodes ?? []).map((m) => [m.code, m]));
  const ms = (code: string) => d?.headline.milestones.find((m) => m.code === code);
  const regionName = (r: { region_id: number; region_name: string; region_name_ar?: string | null }) => (ar && r.region_name_ar ? r.region_name_ar : r.region_name);
  const ps = d?.headline.project_status;
  const fc = d?.headline.final_closure;
  const basis = d?.basis;
  const mileKpi = (code: string, key: string) => {
    const m = ms(code);
    return (
      <Kpi key={code} testid={`dash-kpi-${key}`} title={m ? name(m) : code} to={sites({ stage_code: code })}
        value={m ? pct(m.done_pct) : '–'}
        sub={m ? <>{t('dash.pipeline.done_of', { done: m.done, app: m.applicable })} · <span className={m.vs_plan < 0 ? 'font-semibold text-lateInk' : ''}>{t('dash.kpi.vs_plan', { n: signed(m.vs_plan) })}</span></> : undefined} />
    );
  };

  return (
    <div className="space-y-4" data-testid="page-dashboard">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{t('dash.title')}</h1>
          {basis && <span className={`chip ${basis.source === 'live' ? 'bg-doneBg text-doneInk' : 'bg-waitBg text-waitInk'}`} data-testid="dash-basis" data-source={basis.source}>
            {t(`dash.basis.${basis.source}`, { date: basis.ref_date })}
          </span>}
          {dash.isFetching && <span className="text-sm text-mute" role="status">{t('common.loading')}</span>}
        </div>
        <p className="text-mute">{t('dash.subtitle')}</p>
      </header>

      {/* filters, reference date, export */}
      <div role="toolbar" aria-label={t('dash.filters.label')} className="card flex flex-wrap items-end gap-3 p-3" data-testid="dash-filters">
        <label className="text-sm font-semibold">{t('dash.filters.region')}
          <select className="input mt-1 w-auto font-normal" data-testid="dash-filter-region" value={q.region_id} onChange={(e) => setParam({ region_id: e.target.value })}>
            <option value="">{t('sites.all_regions')}</option>
            {(d?.filters.regions ?? []).map((r) => <option key={r.id} value={String(r.id)}>{ar && r.name_ar ? r.name_ar : r.name_en}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold">{t('dash.filters.cluster')}
          <select className="input mt-1 w-auto font-normal" data-testid="dash-filter-cluster" value={q.cluster_code} onChange={(e) => setParam({ cluster_code: e.target.value })}>
            <option value="">{t('dash.filters.all_clusters')}</option>
            {(d?.filters.clusters ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold">{t('dash.filters.scenario')}
          <select className="input mt-1 w-auto font-normal" data-testid="dash-filter-scenario" value={q.scenario} onChange={(e) => setParam({ scenario: e.target.value })}>
            <option value="">{t('sites.all_scenarios')}</option>
            {(d?.filters.scenarios ?? []).map((s) => <option key={s} value={s}>{t(`scenario.${s}`)}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold">{t('dash.filters.stream')}
          <select className="input mt-1 w-auto font-normal" data-testid="dash-filter-stream" value={q.stream} onChange={(e) => setParam({ stream: e.target.value })}>
            <option value="">{t('dash.filters.all_streams')}</option>
            {(d?.filters.streams ?? []).map((s) => <option key={s.code} value={s.code}>{streamName(t, i18n.language, s)}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold">{t('dash.filters.view')}
          <select className="input mt-1 w-auto font-normal" data-testid="dash-filter-view" value={q.view} onChange={(e) => setParam({ view: e.target.value })}>
            <option value="">{t('dash.filters.all_views')}</option>
            {(d?.filters.views ?? []).map((v) => <option key={v.code} value={v.code}>{name(v)}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold">{t('dash.ref_date')}
          <input type="date" className="input mt-1 w-auto font-normal" data-testid="dash-ref-date" max={today} value={refDate}
            onChange={(e) => setParam({ ref_date: e.target.value && e.target.value < today ? e.target.value : '' })} />
        </label>
        <button className="btn" data-testid="dash-today" disabled={!q.ref_date} onClick={() => setParam({ ref_date: '' })}>{t('dash.today')}</button>
        <span className="ms-auto flex items-center gap-2">
          {activeFilters > 0 && <button className="btn" data-testid="dash-reset" onClick={() => setParam({ ref_date: '', region_id: '', cluster_code: '', scenario: '', stream: '', view: '' })}><RotateCcw size={16} />{t('dash.reset')}</button>}
          <Link className="btn" to="/dashboard/manual-items" data-testid="dash-manual-link"><PencilLine size={16} />{t('dash.manual_link')}</Link>
          {canExport && (
            <span className="flex items-center gap-1">
              <select className="input w-auto" aria-label={t('dash.export_format')} data-testid="dash-export-format" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
                {(['xlsx', 'csv'] as const).map((f) => <option key={f} value={f}>{t(`dash.format.${f}`)}</option>)}
              </select>
              <button className="btn btn-primary" data-testid="dash-export" disabled={exporting || !d} onClick={doExport}><Download size={16} />{t('dash.export')}</button>
            </span>
          )}
        </span>
        {!!basis?.snapshot_dates?.length && (
          <div className="flex w-full flex-wrap items-center gap-2 text-sm" data-testid="dash-snapshots">
            <span className="text-mute">{t('dash.snapshots')}</span>
            {basis.snapshot_dates.slice(0, 6).map((s) => {
              const kind = basis.snapshot_kinds?.find((k) => k.date === s)?.kind;
              return (
                <button key={s} className={`chip border border-line ${refDate === s ? 'bg-accentSoft text-accentText' : 'bg-card'}`} data-testid={`dash-snapshot-${s}`} data-kind={kind ?? ''} onClick={() => setParam({ ref_date: s })}>
                  <span className="mono">{s}</span>{kind && <span className="ms-1 text-mute" data-testid={`dash-snapshot-kind-${s}`}>· {t(`dash.snapshot_kind.${kind}`)}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {basis?.note && <p role="note" className="rounded-md border border-line bg-waitBg p-3 text-sm text-waitInk" data-testid="dash-basis-note">{t(`dash.basis_note.${basis.source}`, { date: basis.ref_date })}</p>}
      {d && (d.meta.central_items_hidden ?? 0) > 0 && <p role="note" className="text-sm text-mute" data-testid="dash-central-hidden">{t('dash.central_hidden', { n: d.meta.central_items_hidden })}</p>}
      {d && d.headline.sites_total === 0 && <EmptyState title={t('dash.empty')} />}

      {!d ? <p className="text-mute" role="status" data-testid="dash-loading">{t('common.loading')}</p> : (
        <>
          {/* OV-12 (first card, owner request 2026-11-06): the sites on the map (contract 0.14.5); the dashboard filters above narrow it too */}
          <SiteMap testid="dash-site-map" height={520} outer={{ region_id: q.region_id, cluster_code: q.cluster_code, scenario: q.scenario, stream: q.stream === 'DISMANTLE' ? '' : q.stream }} />

          {/* headline */}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <section className="card p-4 xl:col-span-2" data-testid="dash-kpi-progress" aria-label={t('dash.kpi.progress')}>
              <div className="text-sm text-mute">{t('dash.kpi.progress')}</div>
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-5xl font-bold tnum" data-testid="dash-progress-value">{pct(ps?.progress_pct)}</span>
                <span className="chip border border-line" data-testid="dash-planned">{t('dash.kpi.planned')}: {ps?.planned_pct === null || ps?.planned_pct === undefined ? t('dash.kpi.na') : pct(ps.planned_pct)}</span>
                <span className="chip border border-line" data-testid="dash-spi" title={t('dash.kpi.not_evm')}>{t('dash.kpi.spi')}: {(ps?.progress_vs_plan_index ?? ps?.spi) == null ? t('dash.kpi.na') : (ps?.progress_vs_plan_index ?? ps?.spi)}</span>
              </div>
              <div className="my-3"><Bar value={ps?.progress_pct ?? 0} plan={ps?.planned_pct} /></div>
              <div className="text-sm text-mute">{t('dash.kpi.coverage', { n: Math.round(ps?.plan_coverage_pct ?? 0) })} · {t('dash.kpi.ends_hoto')}</div>
              {ps?.partial_index && ps.partial_index.value != null && (ps.planned_pct == null) && (
                <div className="text-sm text-mute" data-testid="dash-partial-index">{t('dash.kpi.partial', { v: ps.partial_index.value, c: Math.round(ps.partial_index.coverage_pct) })}</div>
              )}
              {ps?.central_line && (
                <div className="mt-2 rounded-md border border-dashed border-line p-2 text-sm" data-testid="dash-central-line" role="note">
                  {t('dash.ps.central_line', { m: ps.central_line.measured, t: ps.central_line.total })}
                  {ps.central_line.progress_pct != null && <> · {t('dash.ps.central_pct', { pct: Number(ps.central_line.progress_pct.toFixed(1)) })}</>}
                  <div className="text-xs text-mute">{t('dash.ps.central_hint')}</div>
                </div>
              )}
            </section>
            <section className="card p-4 xl:col-span-2" data-testid="dash-kpi-sites" aria-label={t('dash.kpi.sites')}>
              <div className="flex items-center gap-4">
                <div className="w-32 shrink-0"><EChart build={statusRing} height={128} label={t('dash.kpi.status_chart', { list: STATUSES.filter((s) => s !== 'cancelled').map((s) => `${t(`status.${s}`)} ${d.headline.by_overall_status[s]}`).join(', ') })} testid="dash-status-chart" /></div>
                <div className="min-w-0">
                  <div className="text-sm text-mute">{t('dash.kpi.sites')}</div>
                  <Link to={sites()} className="text-4xl font-bold tnum hover:underline" data-testid="dash-sites-total">{d.headline.sites_total}</Link>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {STATUSES.map((s) => (
                      <Link key={s} to={sites({ overall_status: s })} className={`chip ${STATUS_TONE[s]}`} data-testid={`dash-status-${s}`}>{t(`status.${s}`)} <b className="ms-1 tnum">{d.headline.by_overall_status[s]}</b></Link>
                    ))}
                  </div>
                  {d.headline.sites_cancelled > 0 && <div className="mt-1 text-xs text-mute">{t('dash.kpi.cancelled_note', { n: d.headline.sites_cancelled })}</div>}
                </div>
              </div>
            </section>
            {mileKpi('MS4', 'rfi')}
            {d.headline.on_air ? (
              <Kpi testid="dash-kpi-onair" title={t('dash.kpi.onair')} to={sites({ stage_code: 'MS6' })} value={pct(d.headline.on_air.done_pct)}
                sub={<>{t('dash.pipeline.done_of', { done: d.headline.on_air.done, app: d.headline.on_air.applicable })} · <span className={(d.headline.on_air.vs_plan ?? 0) < 0 ? 'font-semibold text-lateInk' : ''}>{t('dash.kpi.vs_plan', { n: signed(d.headline.on_air.vs_plan ?? 0) })}</span></>} />
            ) : mileKpi('MS6', 'onair')}
            {mileKpi('MS9', 'hoto')}
            <Kpi testid="dash-kpi-closure" title={t('dash.kpi.closure')} to={sites({ overall_status: 'completed' })} value={pct(fc?.closed_pct)}
              sub={<div data-testid="dash-closure-detail">
                {t('dash.kpi.closed_of', { closed: fc?.sites_closed ?? 0, base: fc?.sites_total ?? 0 })}
                <div>{t('dash.kpi.fac_cw')}: <b data-testid="dash-fac-cw">{fc?.pending_cw_fac.count ?? 0}</b> {fc?.pending_cw_fac.oldest_age_days != null && <>({t('dash.kpi.oldest', { n: fc.pending_cw_fac.oldest_age_days })})</>} · {t('dash.kpi.not_due', { n: fc?.pending_cw_fac.not_due ?? 0 })}</div>
                <div>{t('dash.kpi.fac_te')}: <b data-testid="dash-fac-te">{fc?.pending_te_fac.count ?? 0}</b> {fc?.pending_te_fac.oldest_age_days != null && <>({t('dash.kpi.oldest', { n: fc.pending_te_fac.oldest_age_days })})</>} · {t('dash.kpi.not_due', { n: fc?.pending_te_fac.not_due ?? 0 })}</div>
              </div>} />
          </div>

          {/* pipeline */}
          <Card title={t('dash.pipeline.title')} testid="dash-pipeline" aside={
            <span className="flex flex-wrap items-center gap-2 text-sm text-mute">
              <span>{t('dash.pipeline.hint')}</span>
              <span role="radiogroup" aria-label={t('dash.pipeline.preview')} className="inline-flex overflow-hidden rounded-md border border-line" data-testid="dash-pipe-preview">
                {(['A', 'B'] as const).map((v) => {
                  const on = (preview ?? d.meta.pipeline_variant ?? 'A') === v;
                  return (
                    <button key={v} type="button" role="radio" aria-checked={on} data-testid={`dash-pipe-variant-${v}`}
                      className={`px-2 py-1 text-xs ${on ? 'bg-accentSoft text-accentText font-semibold' : 'bg-card text-ink'}`}
                      onClick={() => setPreview(v === (d.meta.pipeline_variant ?? 'A') ? null : v)}>{t(`dash.pipeline.variant_${v}`)}</button>
                  );
                })}
              </span>
            </span>}>
            {preview && preview !== (d.meta.pipeline_variant ?? 'A') && <p className="mb-2 text-xs text-waitInk" role="note" data-testid="dash-pipe-preview-note">{t('dash.pipeline.preview_note', { v: d.meta.pipeline_variant ?? 'A' })}</p>}
            {nodes.length === 0 ? <p className="text-mute">{t('dash.empty')}</p> : (
              <Pipeline nodes={nodes} variant={preview ?? d.meta.pipeline_variant ?? 'A'}
                label={(m) => { const n = byCode.get(m.code); return `${ar && m.name_ar ? m.name_ar : m.name_en}: ${n ? t('dash.pipeline.done_of', { done: n.completed, app: n.sites_total }) : ''}`; }}
                onSelect={(code) => nav(sites({ stage_code: code }))}
                stats={(m) => {
                  const n = byCode.get(m.code);
                  if (!n) return null;
                  return (
                    <span data-testid={`dash-node-${m.code}`}>
                      <span className="mono">{n.completed}/{n.sites_total}</span>
                      {(n.vs_plan ?? 0) !== 0 && <span className={(n.vs_plan ?? 0) < 0 ? 'late' : ''}> {signed(n.vs_plan ?? 0)}</span>}
                      <br />{n.in_progress > 0 && <>{t('dash.pipeline.in_work', { n: n.in_progress })} </>}{n.not_started > 0 && <>{t('dash.pipeline.waiting', { n: n.not_started })} </>}
                      {n.blocked_available === false ? <span className="text-mute" data-testid={`dash-node-blocked-unknown-${m.code}`}>{t('dash.pipeline.blocked_unknown')} </span>
                        : (n.blocked ?? 0) > 0 && <b className="late">{t('dash.pipeline.blocked', { n: n.blocked })} </b>}{(n.overdue_open ?? 0) > 0 && <b className="late">{t('dash.pipeline.overdue', { n: n.overdue_open })}</b>}
                    </span>
                  );
                }} />
            )}
          </Card>

          {/* health + activities */}
          <div className="grid gap-3 lg:grid-cols-2">
            <Card title={t('dash.health.title')} testid="dash-health">
              <div className="grid items-center gap-3 sm:grid-cols-[180px_1fr]">
                <div className="text-center">
                  <EChart build={gauge} height={150} label={t('dash.health.chart', { score: d.health.score ?? '–' })} testid="dash-health-gauge" />
                  {d.health.band && <span className={`chip ${BAND_TONE[d.health.band]}`} data-testid="dash-health-band" data-band={d.health.band}>{t(`dash.health.band.${d.health.band}`)}</span>}
                  <div className="mt-1 text-xs text-mute" data-testid="dash-health-bands">{t('dash.health.bands', { green: d.health.bands.green, amber: d.health.bands.amber })}</div>
                </div>
                <ul className="space-y-1 text-sm" data-testid="dash-health-components">
                  {d.health.components.map((c) => (
                    <li key={c.code} className="flex items-center justify-between gap-2" data-testid={`dash-health-${c.code}`}>
                      <span>{ar && c.name_ar ? c.name_ar : c.name_en} <span className="text-mute">({Number(c.weight.toFixed(1))}%)</span>
                        {c.draft && <span className="chip ms-1 bg-waitBg text-waitInk text-xs" data-testid={`dash-health-draft-${c.code}`}>{t('dash.health.draft_factor')}</span>}</span>
                      {c.excluded ? <span className="chip bg-lockBg text-lockInk">{t('dash.health.excluded')}</span> : <b className="tnum">{c.value === null ? '–' : Number(c.value.toFixed(1))}</b>}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="mt-2 text-xs text-mute">{t('dash.health.note')}</p>
              {d.health.components.some((c) => c.draft) && <p className="text-xs text-mute" data-testid="dash-health-draft-note">{t('dash.health.draft_note')}</p>}
            </Card>
            <Card title={t('dash.ps.title')} testid="dash-ps">
              <ul className="space-y-2">
                {(ps?.activities ?? []).map((a) => (
                  <li key={a.code} data-testid={`dash-ps-${a.code}`}>
                    <div className="flex justify-between text-sm"><span>{name(a)} <span className="text-mute">({a.weight}%)</span></span>{a.measured ? <b className="tnum">{pct(a.progress_pct)}</b> : <span className="chip bg-lockBg text-lockInk">{t('dash.ps.no_data')}</span>}</div>
                    <Bar value={a.measured ? a.progress_pct : 0} tone="bg-open" />
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* streams */}
          <Card title={t('dash.streams.title')} testid="dash-streams" aside={<span className="text-sm text-mute">{t('dash.streams.hint')}</span>}>
            <EChart build={streamBars} height={44 + (d.streams.items.length * 40)} label={t('dash.streams.chart', { list: d.streams.items.map((s) => `${streamName(t, i18n.language, s)}: ${s.counts.done ?? 0}/${s.counts.in_progress ?? 0}/${(s.counts.not_due ?? 0) + (s.counts.not_started ?? 0)}`).join('; ') })} testid="dash-streams-chart" />
            <div className="overflow-x-auto">
              <table className="mt-2 w-full text-sm" data-testid="dash-streams-table">
                <thead><tr className="text-start text-mute"><th className="py-1 text-start">{t('dash.streams.stream')}</th>{['done', 'in_progress', 'not_due', 'not_started', 'na', 'on_hold'].map((k) => <th key={k} className="px-2 text-end">{t(`dash.streams.${k}`)}</th>)}</tr></thead>
                <tbody>
                  {d.streams.items.map((s) => (
                    <tr key={s.code} className="border-t border-line" data-testid={`dash-stream-${s.code}`}>
                      <td className="py-1"><Link className="font-semibold hover:underline" to={sites({ stream: s.code })}>{streamName(t, i18n.language, s)}</Link></td>
                      {(['done', 'in_progress', 'not_due', 'not_started', 'na', 'on_hold'] as const).map((k) => <td key={k} className="px-2 text-end tnum" data-testid={`dash-stream-${s.code}-${k}`}>{s.counts[k] ?? 0}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.streams.items.some((s) => s.by_region.length > 1) && (
              <details className="mt-2" data-testid="dash-streams-regions">
                <summary className="cursor-pointer text-sm font-semibold">{t('dash.streams.by_region')}</summary>
                <div className="overflow-x-auto">
                  <table className="mt-1 w-full text-sm">
                    <thead><tr className="text-mute"><th className="py-1 text-start">{t('dash.streams.stream')}</th>{(d.filters.regions).map((r) => <th key={r.id} className="px-2 text-end">{ar && r.name_ar ? r.name_ar : r.name_en}</th>)}</tr></thead>
                    <tbody>
                      {d.streams.items.map((s) => (
                        <tr key={s.code} className="border-t border-line">
                          <td className="py-1">{streamName(t, i18n.language, s)}</td>
                          {d.filters.regions.map((r) => { const c = s.by_region.find((x) => x.region_id === r.id); return <td key={r.id} className="px-2 text-end tnum">{c ? `${c.done ?? 0}/${c.in_progress ?? 0}/${(c.not_due ?? 0) + (c.not_started ?? 0)}` : '–'}</td>; })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-mute">{t('dash.streams.triple')}</p>
              </details>
            )}
          </Card>

          {/* SLA */}
          <div className="grid gap-3 lg:grid-cols-2">
            <Card title={t('dash.sla.title')} testid="dash-sla" aside={<Link className="text-sm text-link hover:underline" to={sites({ bucket: 'late' })} data-testid="dash-sla-late-link">{t('dash.sla.open_late', { n: d.sla.totals.open_late })}</Link>}>
              <div className="mb-2 flex flex-wrap gap-2 text-sm" data-testid="dash-sla-totals">
                <span className="chip bg-doneBg text-doneInk">{t('dash.sla.on_time')} <b className="ms-1 tnum">{d.sla.totals.open_on_time}</b></span>
                <span className="chip bg-waitBg text-waitInk">{t('dash.sla.at_risk')} <b className="ms-1 tnum">{d.sla.totals.open_at_risk}</b></span>
                <span className="chip bg-lateBg text-lateInk">{t('dash.sla.late')} <b className="ms-1 tnum">{d.sla.totals.open_late}</b></span>
                <span className="chip border border-line">{t('dash.sla.completed')} <b className="ms-1 tnum">{d.sla.totals.completed_on_time}</b>/<b className="tnum">{d.sla.totals.completed_on_time + d.sla.totals.completed_late}</b></span>
              </div>
              {d.sla.by_stage.length === 0 ? <p className="text-mute">{t('dash.sla.none')}</p>
                : <EChart build={slaBars} height={230} label={t('dash.sla.chart', { list: d.sla.by_stage.map((s) => `${s.stage_code} ${s.open_on_time}/${s.open_at_risk}/${s.open_late}`).join('; ') })} testid="dash-sla-chart" />}
            </Card>
            <Card title={t('dash.sla.top_late')} testid="dash-top-late">
              {d.sla.top_late.length === 0 ? <p className="text-mute">{t('dash.sla.no_late')}</p> : (
                <ol className="space-y-1 text-sm">
                  {d.sla.top_late.map((x) => (
                    <li key={x.task_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-2" data-testid={`dash-late-${x.task_id}`}>
                      <span><Link className="mono font-bold hover:underline" to={`/sites/${x.site_id}`}>{x.site_code}</Link> {x.task_code} · {x.task_name}</span>
                      <span className="chip bg-lateBg text-lateInk">{t('dash.sla.days_late', { n: x.days_late_wd })}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>

          {/* gates, issues, delay */}
          <div className="grid gap-3 lg:grid-cols-3">
            <Card title={t('dash.gates.title')} testid="dash-gates" aside={<span className="chip border border-line tnum" data-testid="dash-gates-total">{d.gates.blocked_total ?? '–'}</span>}>
              {d.gates.status === 'historically_unavailable' ? <p className="text-mute" data-testid="dash-gates-unavailable" data-status="historically_unavailable">{t('dash.gates.historically_unavailable', { date: refDate })}</p>
                : d.gates.status === 'snapshot' ? <p className="text-mute" data-testid="dash-gates-unavailable" data-status="snapshot">{t('dash.gates.snapshot', { date: refDate, n: d.gates.blocked_total ?? 0 })}</p>
                : !d.gates.available ? <p className="text-mute" data-testid="dash-gates-unavailable">{t('dash.gates.unavailable')}</p>
                : d.gates.items.length === 0 ? <p className="text-mute">{t('dash.gates.none')}</p> : (
                  <ul className="space-y-2 text-sm">
                    {d.gates.items.slice(0, 8).map((g) => (
                      <li key={`${g.site_id}-${g.gate_code}`} className="rounded-md border border-line p-2" data-testid={`dash-gate-${g.site_code}-${g.gate_code}`}>
                        <div><Link className="mono font-bold hover:underline" to={`/sites/${g.site_id}`}>{g.site_code}</Link> · {g.gate_code} {ar && g.name_ar ? g.name_ar : g.name_en}</div>
                        <ul className="mt-1 list-disc ps-5 text-mute">{g.reasons.length ? g.reasons.map((r, i) => <li key={i}>{r.message}</li>) : <li>{t('dash.gates.no_reason')}</li>}</ul>
                      </li>
                    ))}
                  </ul>
                )}
            </Card>
            <Card title={t('dash.issues.title')} testid="dash-issues" aside={d.issues ? <Link className="text-sm text-link hover:underline" to="/registers/issues" data-testid="dash-issues-link">{t('dash.issues.open_register')}</Link> : undefined}>
              {!d.issues ? <p className="text-mute" data-testid="dash-issues-hidden">{t('dash.issues.hidden')}</p> : (
                <>
                  <div className="mb-2 flex flex-wrap gap-2 text-sm">
                    <span className="chip border border-line" data-testid="dash-issues-open">{t('dash.issues.open')} <b className="ms-1 tnum">{d.issues.open_total}</b></span>
                    <span className="chip border border-line" data-testid="dash-issues-sites">{t('dash.issues.sites')} <b className="ms-1 tnum">{d.issues.sites_with_open_issue}</b></span>
                    {d.issues.oldest_age_wd != null && <span className="chip border border-line">{t('dash.issues.oldest', { n: d.issues.oldest_age_wd })}</span>}
                  </div>
                  {d.issues.by_owner.length > 0 && <EChart build={ownerBars} height={Math.max(90, Math.min(8, d.issues.by_owner.length) * 28 + 16)} label={t('dash.issues.chart', { list: d.issues.by_owner.map((o) => `${o.owner_name ?? t('dash.issues.no_owner')} ${o.count}`).join('; ') })} testid="dash-issues-chart" />}
                  <ul className="mt-2 flex flex-wrap gap-2 text-xs" data-testid="dash-issues-ages">
                    {d.issues.age_buckets.map((b) => <li key={b.key} className="chip border border-line">{t(`dash.issues.age.${b.key}`)} <b className="ms-1 tnum">{b.count}</b></li>)}
                  </ul>
                </>
              )}
            </Card>
            <Card title={t('dash.delay.title')} testid="dash-delay" aside={<span className="chip bg-waitBg text-waitInk" data-testid="dash-delay-draft">{t('dash.delay.draft')}</span>}>
              {d.delay.items.length === 0 ? <p className="text-mute">{t('dash.delay.none')}</p> : (
                <>
                  <EChart build={delayBars} height={Math.max(90, Math.min(8, d.delay.items.length) * 28 + 16)} label={t('dash.delay.chart', { list: d.delay.items.map((i) => `${delayLabel(i)} ${i.late_working_days}`).join('; ') })} testid="dash-delay-chart" />
                  <div className="mt-2 text-xs text-mute" data-testid="dash-delay-note">
                    <span data-testid="dash-delay-total">{t('dash.delay.total', { n: d.delay.total_late_working_days, a: d.delay.attributed_pct ?? 0, u: d.delay.unattributed_pct })}</span>{' '}
                    {(d.delay.suspended_working_days ?? 0) > 0 && <span data-testid="dash-delay-suspended">{t('dash.delay.suspended', { n: d.delay.suspended_working_days })} </span>}
                    {(d.delay.proposed_working_days ?? 0) > 0 && <span data-testid="dash-delay-proposed">{t('dash.delay.proposed', { n: d.delay.proposed_working_days })} </span>}
                    {(d.delay.data_gap_working_days ?? 0) > 0 && <span data-testid="dash-delay-gap">{t('dash.delay.gap', { n: d.delay.data_gap_working_days })} </span>}
                    {t('dash.delay.note')}
                  </div>
                </>
              )}
            </Card>
          </div>

          {/* regions */}
          <Card title={t('dash.regions.title')} testid="dash-regions">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead><tr className="text-mute"><th className="py-1 text-start">{t('sites.region')}</th><th className="px-2 text-end">{t('dash.regions.sites')}</th>{STATUSES.slice(0, 4).map((s) => <th key={s} className="px-2 text-end">{t(`status.${s}`)}</th>)}<th className="px-2 text-end">{t('dash.regions.late')}</th><th className="px-2 text-start">{t('dash.regions.progress')}</th><th className="px-2 text-end">{t('dash.regions.health')}</th></tr></thead>
                <tbody>
                  {d.regions.items.map((r) => (
                    <tr key={r.region_id} className="border-t border-line" data-testid={`dash-region-${r.region_id}`}>
                      <td className="py-1"><Link className="font-semibold hover:underline" to={`/sites?region_id=${r.region_id}`}>{regionName(r)}</Link></td>
                      <td className="px-2 text-end tnum">{r.sites_total}</td>
                      {STATUSES.slice(0, 4).map((s) => <td key={s} className="px-2 text-end tnum">{r.by_overall_status?.[s] ?? 0}</td>)}
                      <td className="px-2 text-end tnum">{r.late ?? 0}</td>
                      <td className="min-w-32 px-2"><div className="flex items-center gap-2"><div className="flex-1"><Bar value={r.progress_pct} /></div><span className="tnum">{pct(r.progress_pct)}</span></div></td>
                      <td className="px-2 text-end tnum">{r.health_score == null ? '–' : Number(r.health_score.toFixed(0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

type DashStream = NonNullable<Dash['streams']['items'][number]['counts']>;
type DelayItem = Dash['delay']['items'][number];

/** A delay row in words: the period's party (or its named external party); unattributed days with their suggested party (Q7) or a data gap (Q181). */
function delayName(t: TFunction, r: DelayItem): string {
  if (r.kind === 'unattributed') {
    if (r.data_gap) return t('dash.delay.data_gap');
    const sug = r.suggested_party;
    if (!sug) return t('dash.delay.unattributed');
    const name = sug.kind === 'default_type' ? t(`dash.delay.type.${sug.name}`, { defaultValue: sug.name }) : sug.name;
    return `${t('dash.delay.unattributed')} (${t('dash.delay.suggested', { name })})`;
  }
  if (r.kind === 'unassigned') return t('dash.delay.unassigned');
  if (r.kind === 'default_type') return t(`dash.delay.type.${r.party}`, { defaultValue: r.party });
  if (r.kind === 'period' && !r.external_party_id && r.period_party) return t(`dash.delay.period.${r.period_party}`, { defaultValue: r.party });
  return r.party;
}
