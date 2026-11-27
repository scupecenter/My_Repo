import { CalendarRange } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useSiteMasterRows, useSiteMasterSections } from '@/api/siteMaster';
import { buildTimeline, posPct } from '@/lib/timeline';
import { fmtDate } from '@/lib/time';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

const TONES = ['#0f766e', '#b45309', '#1d4ed8', '#9333ea', '#be123c', '#4d7c0f', '#0e7490', '#a16207'];
const MAX_COLS = 8;
const DEFAULT_COLS = 4;

/**
 * Item 7: cross-site timeline, read only. One row per site of the Site Master list (same filters, same visibility: the rows come from the Master rows endpoint),
 * one marker per chosen date column, a bar from the first to the last chosen date, and a line for today. The dates cannot be edited here: a date changes only
 * through its task, as in the grid. The columns are chosen in the URL (`tl`) and offered as checkboxes, up to eight.
 */
export function SitesTimeline({ query }: { query: Record<string, string | undefined> }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [sp, setSp] = useSearchParams();
  const sections = useSiteMasterSections();
  const master = sections.data?.items.find((m) => m.key === 'master');
  const dateCols = useMemo(() => (master?.columns ?? []).filter((c) => c.value_type === 'date'), [master]);
  const chosen = useMemo(() => {
    const want = (sp.get('tl') ?? '').split(',').map(Number).filter((n) => dateCols.some((c) => c.ord === n));
    return (want.length ? want : dateCols.slice(0, DEFAULT_COLS).map((c) => c.ord)).slice(0, MAX_COLS);
  }, [sp, dateCols]);
  const q = useSiteMasterRows(master ? 'master' : undefined, { ...Object.fromEntries(Object.entries(query).filter(([, v]) => v)), limit: 100 });
  const today = new Date().toISOString().slice(0, 10);
  const model = useMemo(() => buildTimeline(q.data?.rows ?? [], chosen, today), [q.data, chosen, today]);
  const name = (ord: number) => { const c = dateCols.find((x) => x.ord === ord); return (ar && c?.name_ar) || c?.header || String(ord); };
  const toggle = (ord: number) => setSp((p) => {
    const n = new URLSearchParams(p);
    const next = chosen.includes(ord) ? chosen.filter((x) => x !== ord) : [...chosen, ord].slice(0, MAX_COLS);
    if (next.length) n.set('tl', next.join(',')); else n.delete('tl');
    return n;
  }, { replace: true });

  if (sections.isError || q.isError) return <ErrorState onRetry={() => { void sections.refetch(); void q.refetch(); }} testid="timeline-error" />;
  if (sections.isLoading || q.isLoading) return <LoadingSkeleton testid="timeline-loading" />;
  const total = q.data?.rows.length ?? 0;
  return (
    <div className="card p-3" data-testid="sites-timeline">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-sm font-semibold"><CalendarRange size={16} aria-hidden />{t('timeline.title')}</span>
        <span className="text-xs text-mute">{t('timeline.hint', { max: MAX_COLS })}</span>
      </div>
      <fieldset className="mb-3 flex max-h-28 flex-wrap gap-x-4 gap-y-1 overflow-auto border-0 p-0" data-testid="timeline-cols">
        <legend className="sr-only">{t('timeline.columns')}</legend>
        {dateCols.map((c) => {
          const on = chosen.includes(c.ord);
          const i = chosen.indexOf(c.ord);
          return (
            <label key={c.ord} className="inline-flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={on} disabled={!on && chosen.length >= MAX_COLS} onChange={() => toggle(c.ord)} data-testid={`timeline-col-${c.ord}`} className="accent-[var(--accent)]" />
              {on && <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TONES[i % TONES.length] }} />}
              {(ar && c.name_ar) || c.header}
            </label>
          );
        })}
        {!dateCols.length && <span className="text-sm text-mute">{t('timeline.no_columns')}</span>}
      </fieldset>
      {!model ? <EmptyState testid="timeline-empty" title={t('timeline.empty')} hint={t('timeline.empty_hint')} /> : (
        <div dir="ltr" className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="relative ms-[12.5rem] me-2 h-6 border-b border-line text-[11px] text-mute" aria-hidden>
              {model.months.map((m) => <span key={m.day} className="absolute -translate-x-1/2" style={{ left: `${posPct(model, m.day)}%` }}>{m.label}</span>)}
            </div>
            <div className="relative">
            <span aria-hidden data-testid="timeline-today" title={t('timeline.today')} className="pointer-events-none absolute inset-y-0 z-10 w-px bg-late"
              style={{ left: `calc(12.5rem + (100% - 13rem) * ${posPct(model, Math.floor(Date.parse(`${today}T00:00:00Z`) / 86_400_000)) / 100})` }} />
            <ul data-testid="timeline-rows">
              {model.rows.map((r) => (
                <li key={r.site_id} className="flex items-center border-b border-line/60 py-1" data-testid={`timeline-row-${r.code}`}>
                  <Link to={`/sites/${r.site_id}`} className="w-48 shrink-0 truncate pe-2 text-sm text-ink hover:underline" ><b className="mono">{r.code}</b></Link>
                  <div className="relative mx-2 h-5 flex-1">
                    <span className="absolute top-1/2 h-1 -translate-y-1/2 rounded bg-line" style={{ left: `${posPct(model, r.from)}%`, width: `${Math.max(posPct(model, r.to) - posPct(model, r.from), 0.4)}%` }} />
                    {r.points.map((p) => (
                      <span key={p.ord} role="img" aria-label={`${name(p.ord)}: ${fmtDate(p.iso, i18n.language)}`} title={`${name(p.ord)}: ${fmtDate(p.iso, i18n.language)}`}
                        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card" style={{ left: `${posPct(model, p.day)}%`, background: TONES[chosen.indexOf(p.ord) % TONES.length] }} />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            </div>
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-mute" data-testid="timeline-note">{t('timeline.note', { shown: model?.rows.length ?? 0, total, all: q.data?.filtered ?? total })}</p>
    </div>
  );
}
