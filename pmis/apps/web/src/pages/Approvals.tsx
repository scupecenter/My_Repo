import { Check, Clock, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useApprovals, useBulk, useDecide } from '@/api/hooks';
import type { ApprovalItem } from '@/api/types';
import { Holders } from '@/components/HolderChip';
import { LayoutPanel } from '@/components/LayoutPanel';
import { PersonTag } from '@/components/PersonTag';
import { RejectDialog } from '@/components/RejectDialog';
import { QuickFilter, useTablePrefs } from '@/components/TableKit';
import { displayAttrs, ExportCsvButton, PastedChip, RowNo, SearchBox, TableCount, TableToolbar } from '@/components/TableStandard';
import { SavedViews } from '@/components/SavedViews';
import { UnifiedFilter } from '@/components/UnifiedFilter';
import { decodeFilter, encodeFilter, type FilterTree } from '@/api/views';
import { BallSince, ExternalParty, SlaOverrun, StaleBadge, TIMING_SORTS, sortByTiming, type TimingSort } from '@/components/TaskTiming';
import { useToast } from '@/components/Toast';
import { taskErrorMessage } from '@/lib/taskErrors';

const TABS = ['all', 'review', 'approve'] as const;
const COLOURS = ['red', 'amber', 'green'] as const;
const VIEW_EMPTY = { tab: 'all', q: '', colours: '', stale: '' };
const NO_COLS: never[] = [];

export function Approvals() {
  const { t } = useTranslation();
  const toast = useToast();
  const [tab, setTab] = useState<(typeof TABS)[number]>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<ApprovalItem | null>(null);
  // F2 (0.15.30): colour and stale filter on the server; the timing sort orders the loaded page
  const [colours, setColours] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [sort, setSort] = useState<TimingSort>('');
  // W8: the + Filter tree (tasks-board whitelist) goes to the server with the search; the Display options are per user (screen approvals)
  const [adv, setAdv] = useState('');
  const advTree = decodeFilter(adv);
  const tbl = useTablePrefs('approvals', NO_COLS);
  const list = useApprovals(tab, q, { colours, stale, filter: adv || undefined });
  const decide = useDecide();
  const bulk = useBulk();
  const items = sortByTiming(list.data?.items ?? [], sort, (i) => i.task);
  const current = items.find((i) => i.task.id === sel) ?? null;

  const onError = (e: unknown) => { const m = taskErrorMessage(t, e); if (m) toast(m, 'err'); };
  const [report, setReport] = useState<{ ref: string; site: string; code: string; message: string; kind: 'skipped' | 'failed' }[]>([]);

  const act = (item: ApprovalItem, op: 'review' | 'approve') =>
    decide.mutate({ item, op }, { onSuccess: () => toast(t('approvals.done')), onError });

  const picked = items.filter((i) => checked.has(i.task.id));
  const kindOfPicked = picked.length && picked.every((i) => i.level_kind === picked[0].level_kind) ? picked[0].level_kind : null;
  const runBulk = (action: 'pass' | 'approve') =>
    bulk.mutate({ action, items: picked }, {
      onSuccess: (r) => {
        setChecked(new Set());
        const issue = (kind: 'skipped' | 'failed') => (i: { ref: string; code: string; message?: string }) => ({ ref: i.ref, site: picked.find((p) => p.task.id === i.ref)?.task.site_code ?? i.ref, code: i.code, kind, message: taskErrorMessage(t, new ApiError(422, { code: i.code, title: i.message ?? i.code, status: 422, type: 'about:blank' } as never)) || (i.message ?? i.code) });
        setReport([...r.skipped.map(issue('skipped')), ...r.failed.map(issue('failed'))]);
        toast(t('approvals.bulk_result', { done: r.done.length, skipped: r.skipped.length, failed: r.failed.length }), r.failed.length ? 'err' : 'ok'); },
      onError,
    });

  const allChecked = items.length > 0 && picked.length === items.length;
  const active = !!(q.trim() || adv || colours.length || stale || tab !== 'all');
  const clearAll = () => { setQ(''); setAdv(''); setColours([]); setStale(false); setTab('all'); };

  return (
    <div data-testid="page-approvals">
      <h1 className="text-2xl font-bold">{t('approvals.title')}</h1>
      <p className="mb-4 text-mute">{t('approvals.subtitle')}</p>
      {/* W8: the shared toolbar (a master-detail list: no column chooser; the Display options apply to the list) */}
      <TableToolbar testid="approvals-toolbar" kind="list"
        views={<SavedViews screen="approvals" value={{ tab, q, colours: colours.join(','), stale: stale ? 'true' : '', ...(advTree ? { advanced: advTree } : {}) }} empty={VIEW_EMPTY} table={tbl}
          onApply={(v) => { const r = v as Record<string, unknown>; setTab((TABS as readonly string[]).includes(String(r.tab)) ? (r.tab as (typeof TABS)[number]) : 'all'); setQ(String(r.q ?? '')); setColours(String(r.colours ?? '').split(',').filter(Boolean)); setStale(r.stale === 'true'); setAdv(encodeFilter(r.advanced as FilterTree | undefined)); }} />}
        search={<SearchBox testid="approvals-filter" value={q} onChange={setQ} placeholder={t('approvals.filter')} />}
        filter={<UnifiedFilter screen="tasks-board" value={advTree} onChange={(tree) => setAdv(encodeFilter(tree))} onClearAll={clearAll} />}
        extra={<PastedChip search={list.data?.search} />}
        count={<TableCount testid="approvals-count" noun="tasks" total={list.data?.counts?.total ?? items.length} filtered={list.data?.counts?.filtered ?? items.length} active={active} selected={picked.length} onClear={clearAll} />}
        layout={<LayoutPanel testid="approvals-layout" table={tbl} />}
        exporter={<ExportCsvButton testid="approvals-export" name="approvals" head={['#', t('sites.code'), t('grid.code'), t('grid.task'), t('approvals.entered_by'), t('approvals.sla')]}
          rows={() => items.map((i, k) => [k + 1, i.task.site_code, i.task.task_code, i.task.name_en, i.submitted_by?.display_name ?? '', i.task.sla?.colour ?? ''])} />} />
      <div className="grid gap-4 lg:grid-cols-[minmax(320px,5fr)_7fr]">
        <section className="card overflow-hidden">
          <div role="tablist" className="flex border-b border-line">
            {TABS.map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} data-testid={`approvals-tab-${k}`} onClick={() => setTab(k)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-semibold ${tab === k ? 'border-b-2 border-accent text-accentText' : 'text-mute'}`}>
                {t(`approvals.tab_${k}`)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 border-b border-line p-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="approval-select-all" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(items.map((i) => i.task.id)))} />{t('approvals.select_all')}</label>
          </div>
          <div role="toolbar" aria-label={t('timing.filters')} className="flex flex-wrap items-center gap-2 border-b border-line p-3" data-testid="approvals-timing">
            {COLOURS.map((c) => <QuickFilter key={c} testid={`approvals-colour-${c}`} on={colours.includes(c)} onClick={() => setColours((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]))}>{t(`timing.filter_${c}`)}</QuickFilter>)}
            <QuickFilter testid="approvals-stale" on={stale} onClick={() => setStale((x) => !x)}>{t('timing.filter_stale')}</QuickFilter>
            <label className="ms-auto flex items-center gap-1 text-sm"><span className="text-mute">{t('timing.sort')}</span>
              <select className="input py-1" data-testid="approvals-sort" value={sort} onChange={(e) => setSort(e.target.value as TimingSort)}>
                {TIMING_SORTS.map((k) => <option key={k} value={k}>{t(`timing.sort_${k}`)}</option>)}
              </select>
            </label>
          </div>
          {picked.length > 0 && (
            <div className="flex items-center gap-2 border-b border-line bg-accentSoft p-3" data-testid="bulk-bar">
              <span className="flex-1 text-sm font-semibold">{t('approvals.selected', { count: picked.length })}</span>
              {kindOfPicked === 'review' && <button className="btn" data-testid="bulk-pass" onClick={() => runBulk('pass')}>{t('approvals.bulk_pass', { count: picked.length })}</button>}
              {kindOfPicked === 'approve' && <button className="btn btn-primary" data-testid="bulk-approve" onClick={() => runBulk('approve')}>{t('approvals.bulk_approve', { count: picked.length })}</button>}
            </div>
          )}
          {report.length > 0 && (
            <div className="border-b border-line bg-waitBg p-3 text-sm text-waitInk" data-testid="bulk-report">
              <div className="flex items-center"><b className="flex-1">{t('approvals.bulk_issues')}</b><button className="btn px-2 py-0.5 text-xs" onClick={() => setReport([])}>{t('common.close')}</button></div>
              <ul>{report.map((r) => <li key={r.ref} data-testid={`bulk-issue-${r.code}`}><b className="mono">{r.site}</b> · {t(r.kind === 'failed' ? 'approvals.bulk_failed' : 'approvals.bulk_skipped')}: {r.message}</li>)}</ul>
            </div>
          )}
          <ul data-testid="approvals-list" {...displayAttrs(tbl.display)}>
            {items.map((i, k) => (
              <li key={i.task.id} data-testid={`approval-row-${i.task.id}`} data-site={i.task.site_code} aria-selected={sel === i.task.id}
                role="listitem" data-zebra={k % 2 ? '1' : '0'}
                className={`flex items-center gap-3 border-b border-line ${tbl.display.density === 'compact' ? 'p-1.5' : tbl.display.density === 'normal' ? 'p-2' : 'p-3'} ${sel === i.task.id ? 'bg-openBg' : tbl.display.zebra && k % 2 ? 'bg-card2 hover:bg-hover' : 'hover:bg-hover'}`}>
                <span data-col="rowno" className="w-6 shrink-0"><RowNo n={k + 1} /></span>
                <input type="checkbox" aria-label={i.task.site_code} data-testid={`approval-check-${i.task.id}`} checked={checked.has(i.task.id)}
                  onChange={() => setChecked((c) => { const n = new Set(c); if (n.has(i.task.id)) n.delete(i.task.id); else n.add(i.task.id); return n; })} />
                <button className="flex-1 text-start" data-testid={`approval-open-${i.task.id}`} onClick={() => setSel(i.task.id)}>
                  <div><b className="mono">{i.task.site_code}</b> {i.task.task_code} {i.task.name_en}</div>
                  <div className="text-sm text-mute">{t('approvals.entered_by')} {i.submitted_by?.display_name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1"><SlaOverrun task={i.task} /><BallSince task={i.task} /><StaleBadge task={i.task} /></div>
                </button>
                <span className={`chip ${i.level_kind === 'approve' ? 'bg-waitBg text-waitInk' : 'bg-openBg text-openInk'}`}>{t(`approvals.level_${i.level_kind}`)}</span>
              </li>
            ))}
            {list.isSuccess && !items.length && <li className="p-6 text-center text-mute" data-testid="approvals-empty">{t('approvals.empty')}</li>}
          </ul>
        </section>
        <section className="card self-start" data-testid="approval-detail">
          {current ? <Detail item={current} onAct={act} onReject={() => setRejecting(current)} busy={decide.isPending} /> : <p className="p-6 text-mute">{t('approvals.select_one')}</p>}
        </section>
      </div>
      <RejectDialog key={rejecting?.task.id} open={!!rejecting} title={t('approvals.reject_title', { site: rejecting?.task.site_code })} onClose={() => setRejecting(null)} onSend={(note) => rejecting && decide.mutate({ item: rejecting, op: 'reject', note }, { onSuccess: () => { setRejecting(null); toast(t('approvals.done')); }, onError })} />
    </div>
  );
}

function Detail({ item, onAct, onReject, busy }: { item: ApprovalItem; onAct: (i: ApprovalItem, op: 'review' | 'approve') => void; onReject: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const tk = item.task;
  const op = item.level_kind === 'approve' ? 'approve' : 'review';
  return (
    <div>
      <div className="flex items-center justify-between border-b border-line p-4">
        <b><span className="mono">{tk.site_code}</span> · {tk.task_code} {tk.name_en}</b>
        <span className="chip bg-waitBg text-waitInk"><Clock size={12} className="me-1" />{item.level_kind === 'approve' ? t('approvals.awaiting') : t('approvals.in_review')}</span>
      </div>
      <dl className="grid grid-cols-2 gap-4 p-4 text-sm">
        <div><dt className="text-mute">{t('approvals.entered_by')}</dt><dd className="font-semibold">{item.submitted_by && <PersonTag name={item.submitted_by.display_name} employeeId={item.submitted_by.employee_id} />}</dd></div>
        <div><dt className="text-mute">{t('approvals.actual_date')}</dt><dd className="mono font-semibold">{tk.actual_date} <span className="font-normal text-mute">({t('approvals.plan')} {tk.planned_date})</span></dd></div>
        <div><dt className="text-mute">{t('grid.ball')}</dt><dd data-testid="approval-holders"><Holders holders={tk.ball_in_court?.holders ?? []} /><div className="mt-1 flex flex-wrap items-center gap-1"><ExternalParty task={tk} /><BallSince task={tk} testid="approval-ball-since" /><StaleBadge task={tk} testid="approval-stale" /></div></dd></div>
        <div><dt className="text-mute">{t('approvals.sla')}</dt><dd className="font-semibold">{tk.sla?.min_wd}–{tk.sla?.max_wd} {t('approvals.wd')} <SlaOverrun task={tk} testid="approval-overrun" /></dd></div>
      </dl>
      <div className="px-4 pb-2 text-sm">
        <div className="font-semibold">{t('approvals.documents', { count: item.documents_summary?.length ?? tk.slots_filled ?? 0 })}</div>
        <ul data-testid="approval-docs">{item.documents_summary?.map((s) => <li key={s.slot_id} className="mono py-1">{s.name} <span className="chip bg-waitBg text-waitInk">{s.status}</span> <span className="text-mute">×{s.file_count}</span></li>)}</ul>
      </div>
      <div className="flex gap-2 p-4">
        <button className="btn btn-danger ms-auto" data-testid="approval-reject" onClick={onReject} disabled={busy}><Undo2 size={16} />{t('approvals.reject')}</button>
        <button className="btn btn-primary" data-testid={op === 'approve' ? 'approval-approve' : 'approval-pass'} onClick={() => onAct(item, op)} disabled={busy}><Check size={16} />{t(op === 'approve' ? 'approvals.approve' : 'approvals.pass')}</button>
      </div>
    </div>
  );
}
