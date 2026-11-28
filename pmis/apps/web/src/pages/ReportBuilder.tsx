import { ArrowDown, ArrowUp, CalendarClock, Download, Plus, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useExportParts, useStartExport } from '@/api/admin';
import { useSaveExportSchedule, type ExportScheduleInput } from '@/api/exportSchedules';
import { decodeFilter, encodeFilter, useFilterFields, useSavedViewOps, useSavedViews, type FilterTree, type SavedView } from '@/api/views';
import { api } from '@/api/client';
import { useQuery } from '@tanstack/react-query';
import { exportError } from '@/components/ExportDialog';
import { FilterTreeEditor } from '@/components/FilterBuilder';
import { errText } from '@/components/FormDialog';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';

/** Parts that are not registers: they have their own screens and no register filter fields. */
const NOT_REGISTERS = new Set(['sites', 'tasks', 'milestones', 'project_status']);
const EMPTY_TREE: FilterTree = { op: 'and', items: [] };
type Col = { code: string; label_en: string; label_ar: string };

/** Parts with their columns (the same call the Export dialog makes): only parts the caller may export are listed. */
const usePartsWithColumns = () =>
  useQuery({ queryKey: ['export-columns'], staleTime: Infinity, queryFn: () => api.get<{ items: { key: string; label_en: string; label_ar: string; columns?: Col[] }[] }>('/exports/parts', { query: { include_columns: true } }).then((r) => r.items) });

/**
 * Report builder. A report is a saved view of a register (filters as the AND/OR tree and the columns in order; register exports have no sort, so none is offered), so it keeps
 * everything saved views already do: private by default, versioned, shareable by the views.share right, hidden fields stripped for each reader. Running a report is
 * "Export current view" (POST /exports/master with `view`) and scheduling it is a scheduled export with `spec.view` (0.15.584): both check the reader's export grant,
 * regions and field rules again when they run, so a report never widens what anyone gets. Nothing new is stored: no table, no permission.
 */
export function ReportBuilderPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const ar = i18n.language.startsWith('ar');
  const parts = usePartsWithColumns();
  const registers = useMemo(() => (parts.data ?? []).filter((p) => !NOT_REGISTERS.has(p.key) && (p.columns?.length ?? 0) > 0), [parts.data]);
  const [source, setSource] = useState('');
  useEffect(() => { if (!source && registers[0]) setSource(registers[0].key); }, [registers, source]);
  const screen = source ? `register-${source}` : '';
  const part = registers.find((p) => p.key === source);
  const fields = useFilterFields(screen, !!source);
  const saved = useSavedViews(screen || 'register-none');
  const ops = useSavedViewOps(screen);
  const start = useStartExport();
  const sched = useSaveExportSchedule();
  const [open, setOpen] = useState<SavedView | null>(null);
  const [name, setName] = useState('');
  const [tree, setTree] = useState<FilterTree>(EMPTY_TREE);
  const [cols, setCols] = useState<string[]>([]);
  const [cad, setCad] = useState<ExportScheduleInput['cadence']>('weekly');
  const [mail, setMail] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const label = (c: Col) => (ar && c.label_ar ? c.label_ar : c.label_en);
  const all = part?.columns ?? [];
  const byCode = new Map(all.map((c) => [c.code, c]));
  const reset = (cs: string[] = all.filter(() => false).map((c) => c.code)) => { setOpen(null); setName(''); setTree(EMPTY_TREE); setCols(cs); setErr(null); };
  // a new source starts with the columns the screen shows by default (all of them are offered; none is hidden by the builder)
  useEffect(() => { reset(all.slice(0, 8).map((c) => c.code)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [source, parts.data]);
  const load = (v: SavedView) => {
    setOpen(v); setName(v.name); setErr(null);
    setTree(decodeFilter(typeof (v.filters as { filter?: unknown })?.filter === 'string' ? (v.filters as { filter: string }).filter : null) ?? ((v.filters as { advanced?: FilterTree })?.advanced ?? EMPTY_TREE));
    setCols((v.columns?.order ?? []).filter((c) => byCode.has(c) && !(v.columns?.hidden ?? []).includes(c)));
  };
  const move = (i: number, d: -1 | 1) => setCols((c) => { const n = [...c]; const j = i + d; if (j < 0 || j >= n.length) return c; [n[i], n[j]] = [n[j]!, n[i]!]; return n; });
  const toggle = (code: string) => setCols((c) => (c.includes(code) ? c.filter((x) => x !== code) : [...c, code]));
  const view = () => ({ source: source as never, filters: tree.items.length ? { filter: encodeFilter(tree) } : {}, columns: cols as never });
  const body = () => ({ name: name.trim(), filters: { advanced: tree }, columns: { order: cols, hidden: [] as string[] } });
  const ready = !!source && cols.length > 0;
  const save = () => {
    setErr(null);
    if (open) ops.update.mutate({ view: open, patch: { ...body(), reason: t('reports.reason') } }, { onSuccess: (v) => { setOpen(v); toast(t('reports.saved')); }, onError: (e) => setErr(errText(e, t)) });
    else ops.create.mutate(body(), { onSuccess: (v) => { setOpen(v); toast(t('reports.saved')); }, onError: (e) => setErr(errText(e, t)) });
  };
  const run = () => start.mutate({ view: view() }, { onSuccess: () => toast(t('reports.run_started')), onError: (e) => toast(exportError(e, t, (k) => k), 'err') });
  const schedule = () => sched.mutate({ name: name.trim() || part?.label_en || source, cadence: cad, ...(cad === 'weekly' ? { weekday: 1 } : {}), ...(cad === 'monthly' ? { day_of_month: 1 } : {}), spec: { view: view() } as never, enabled: true, mail },
    { onSuccess: () => toast(t('reports.scheduled')), onError: (e) => toast(errText(e, t), 'err') });

  if (!parts.data) return <div data-testid="page-reports"><PageHeader title={t('reports.title')} subtitle={t('reports.subtitle')} /><QueryFallback queries={[parts]} testid="reports-loading" /></div>;
  if (!registers.length) return <div data-testid="page-reports"><PageHeader title={t('reports.title')} subtitle={t('reports.subtitle')} /><EmptyState title={t('reports.none_exportable')} /></div>;
  return (
    <div data-testid="page-reports" className="space-y-4">
      <PageHeader title={t('reports.title')} subtitle={t('reports.subtitle')} />
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <aside className="card space-y-3 p-4" aria-label={t('reports.saved_title')}>
          <label className="block text-sm font-semibold">{t('reports.source')}
            <select className="input mt-1 w-full" value={source} onChange={(e) => setSource(e.target.value)} data-testid="reports-source">
              {registers.map((p) => <option key={p.key} value={p.key}>{ar && p.label_ar ? p.label_ar : p.label_en}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-2"><h2 className="text-sm font-bold">{t('reports.saved_title')}</h2>
            <button type="button" className="btn ms-auto px-2" onClick={() => reset(all.slice(0, 8).map((c) => c.code))} data-testid="reports-new"><Plus size={14} aria-hidden /> {t('reports.new')}</button></div>
          {saved.data?.items.length ? (
            <ul className="space-y-1" data-testid="reports-list">
              {saved.data.items.map((v) => (
                <li key={v.id}><button type="button" className={`w-full rounded px-2 py-1 text-start text-sm hover:bg-surface-2 ${open?.id === v.id ? 'bg-surface-2 font-semibold' : ''}`} onClick={() => load(v)} data-testid={`reports-open-${v.id}`}>{v.name}</button></li>
              ))}
            </ul>
          ) : <p className="text-sm text-mute" data-testid="reports-empty">{t('reports.no_saved')}</p>}
          <p className="text-xs text-mute">{t('reports.sharing_note')}</p>
        </aside>
        <section className="card space-y-4 p-4" aria-label={t('reports.builder')}>
          <label className="block text-sm font-semibold">{t('reports.name')}
            <input className="input mt-1 w-full" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('reports.name_hint')} data-testid="reports-name" />
          </label>
          <div>
            <h2 className="mb-1 text-sm font-bold">{t('reports.filters')}</h2>
            {fields.data ? <FilterTreeEditor tree={tree} fields={fields.data.items} onChange={setTree} screen={screen} /> : <QueryFallback queries={[fields]} testid="reports-fields-loading" />}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h2 className="mb-1 text-sm font-bold">{t('reports.columns')} <span className="font-normal text-mute" data-testid="reports-col-count">({cols.length})</span></h2>
              <ul className="max-h-64 space-y-0.5 overflow-auto rounded border border-line p-2 text-sm" data-testid="reports-columns">
                {all.map((c) => (
                  <li key={c.code}><label className="flex items-center gap-2"><input type="checkbox" checked={cols.includes(c.code)} onChange={() => toggle(c.code)} data-testid={`reports-col-${c.code}`} />{label(c)}</label></li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="mb-1 text-sm font-bold">{t('reports.order')}</h2>
              <ol className="max-h-64 space-y-0.5 overflow-auto rounded border border-line p-2 text-sm" data-testid="reports-order">
                {cols.map((code, i) => (
                  <li key={code} className="flex items-center gap-1"><span className="min-w-0 flex-1 truncate">{byCode.get(code) ? label(byCode.get(code) as Col) : code}</span>
                    <button type="button" className="btn px-1" aria-label={t('reports.up')} disabled={i === 0} onClick={() => move(i, -1)} data-testid={`reports-up-${code}`}><ArrowUp size={12} aria-hidden /></button>
                    <button type="button" className="btn px-1" aria-label={t('reports.down')} disabled={i === cols.length - 1} onClick={() => move(i, 1)} data-testid={`reports-down-${code}`}><ArrowDown size={12} aria-hidden /></button></li>
                ))}
              </ol>
            </div>
          </div>
          {err && <p className="text-sm text-bad" role="alert" data-testid="reports-error">{err}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <button type="button" className="btn" disabled={!ready || !name.trim() || ops.create.isPending || ops.update.isPending} onClick={save} data-testid="reports-save"><Save size={16} aria-hidden /> {open ? t('reports.save_changes') : t('reports.save')}</button>
            <button type="button" className="btn" disabled={!ready || start.isPending} onClick={run} data-testid="reports-run"><Download size={16} aria-hidden /> {t('reports.run')}</button>
            <span className="ms-auto flex flex-wrap items-center gap-2 text-sm">
              <select className="input" value={cad} onChange={(e) => setCad(e.target.value as ExportScheduleInput['cadence'])} aria-label={t('reports.cadence')} data-testid="reports-cadence">
                <option value="daily">{t('exportSchedules.cad_daily')}</option><option value="weekly">{t('exportSchedules.cad_weekly')}</option><option value="monthly">{t('exportSchedules.cad_monthly')}</option>
              </select>
              <label className="flex items-center gap-1"><input type="checkbox" checked={mail} onChange={(e) => setMail(e.target.checked)} data-testid="reports-mail" />{t('reports.mail_me')}</label>
              <button type="button" className="btn" disabled={!ready || sched.isPending} onClick={schedule} data-testid="reports-schedule"><CalendarClock size={16} aria-hidden /> {t('reports.schedule')}</button>
            </span>
          </div>
          <p className="text-xs text-mute">{t('reports.rights_note')} <Link to="/admin/settings/data/export" className="text-link" data-testid="reports-schedules-link">{t('reports.manage_schedules')}</Link></p>
        </section>
      </div>
    </div>
  );
}
