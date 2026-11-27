import { LayoutPanel, type ViewOption } from '@/components/LayoutPanel';
import { AlertTriangle, CalendarDays, Check, Clock, Columns3, Inbox, List, Pencil } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { downloadFile } from '@/api/client';
import { useMe, useMyTasks } from '@/api/hooks';
import type { TaskSummary } from '@/api/types';
import { Holders } from '@/components/HolderChip';
import { MyWorkCalendar } from '@/components/MyWorkCalendar';
import { PersonTag } from '@/components/PersonTag';
import { TaskDrawer } from '@/components/TaskDrawer';
import { BallSince, ExternalParty, SlaOverrun, StaleBadge } from '@/components/TaskTiming';
import { TasksBoard } from '@/components/TasksBoard';
import { SavedViews } from '@/components/SavedViews';
import { UnifiedFilter } from '@/components/UnifiedFilter';
import { ColumnMenu, Empty, HeaderRow, pin, rowPad, totalWidth, tracks, Trunc, useTablePrefs, type TableApi } from '@/components/TableKit';
import { displayAttrs, ExportCsvButton, PastedChip, ROWNO_COL, RowNo, SearchBox, TableCount, TableToolbar } from '@/components/TableStandard';
import { decodeFilter, encodeFilter, type FilterTree } from '@/api/views';
import type { ColDef } from '@/lib/tablePrefs';

const SLA_CHIP: Record<string, string> = { green: 'bg-doneBg text-doneInk', amber: 'bg-waitBg text-waitInk', red: 'bg-lateBg text-lateInk', none: 'bg-lockBg text-lockInk' };

/** The card is a button: Enter or click opens the task drawer straight away (plan E1); the drawer returns focus to the card. */
export function TaskCard({ task, onOpen }: { task: TaskSummary; onOpen?: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const name = i18n.language === 'ar' && task.name_ar ? task.name_ar : task.name_en;
  const claimed = task.ball_in_court?.claimed_by;
  return (
    <li className="cursor-pointer rounded-md border border-line bg-card p-3 hover:bg-hover" data-testid={`task-card-${task.id}`} onClick={(e) => { if (!(e.target as HTMLElement).closest('button,a')) onOpen?.(task.id); }}>
      <div><button type="button" className="sr-only" data-testid={`task-card-open-${task.id}`} onClick={() => onOpen?.(task.id)}>{task.site_code} {task.task_code}</button><b className="mono">{task.site_code}</b> {task.task_code} · {name}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mute">
        {task.sla?.colour && <span className={`chip ${SLA_CHIP[task.sla.colour]}`}>{t('approvals.sla')} {task.sla.elapsed_wd ?? '–'}/{task.sla.max_wd ?? '–'} {t('approvals.wd')}</span>}
        <SlaOverrun task={task} />
        {claimed ? <PersonTag name={claimed.display_name} employeeId={claimed.employee_id} />
          : <Holders holders={task.ball_in_court?.holders ?? []} />}
        <ExternalParty task={task} /><BallSince task={task} /><StaleBadge task={task} />
      </div>
      {task.last_return_note && <div className="mt-1 text-sm text-lateInk">{t('approvals.returned_note', { note: task.last_return_note })}</div>}
    </li>
  );
}

// W8: My Work as a table like the Site Master lists: #, Site ID, Task, SLA, Ball in court, Since, grouped under the three buckets
const DEFS: ColDef[] = [ROWNO_COL, { id: 'site', w: 110, min: 80, pinned: true }, { id: 'task', w: 300, min: 140 }, { id: 'sla', w: 220, min: 120 }, { id: 'ball', w: 220, min: 120 }, { id: 'since', w: 200, min: 120 }];
const LABEL: Record<string, string> = { rowno: 'tstd.rowno', site: 'sites.code', task: 'grid.task', sla: 'grid.sla', ball: 'grid.ball', since: 'tstd.since' };
const BUCKETS = [['late', AlertTriangle], ['do_now', Pencil], ['waiting', Clock]] as const;

function Row({ task, n, tbl, onOpen }: { task: TaskSummary; n: number; tbl: TableApi; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const name = i18n.language === 'ar' && task.name_ar ? task.name_ar : task.name_en;
  const claimed = task.ball_in_court?.claimed_by;
  const cell = (id: string): ReactNode => {
    switch (id) {
      case 'rowno': return <RowNo n={n} />;
      case 'site': return <b className="mono">{task.site_code}</b>;
      case 'task': return <span className="block min-w-0"><button type="button" className="flex w-full min-w-0 items-center gap-1 text-start" data-testid={`task-card-open-${task.id}`} onClick={() => onOpen(task.id)}><span className="mono shrink-0 font-semibold">{task.task_code}</span><Trunc text={name} /></button>
        {task.last_return_note && <span className="block truncate text-xs text-lateInk">{t('approvals.returned_note', { note: task.last_return_note })}</span>}</span>;
      case 'sla': return <span className="flex flex-wrap items-center gap-1">{task.sla?.colour ? <span className={`chip ${SLA_CHIP[task.sla.colour]}`}>{task.sla.elapsed_wd ?? '–'}/{task.sla.max_wd ?? '–'} {t('approvals.wd')}</span> : <Empty />}<SlaOverrun task={task} /></span>;
      case 'ball': return <span className="flex flex-wrap items-center gap-1">{claimed ? <PersonTag name={claimed.display_name} employeeId={claimed.employee_id} /> : <Holders holders={task.ball_in_court?.holders ?? []} />}<ExternalParty task={task} /></span>;
      default: return <span className="flex flex-wrap items-center gap-1"><BallSince task={task} /><StaleBadge task={task} /></span>;
    }
  };
  return (
    <div role="listitem" data-testid={`task-card-${task.id}`} data-zebra={n % 2 === 0 ? '1' : '0'} className={`gx-row grid cursor-pointer items-center border-b border-line text-sm ${rowPad(tbl.density)}`}
      style={{ gridTemplateColumns: tracks(tbl.cols, false), minWidth: totalWidth(tbl.cols, false) }} onClick={(e) => { if (!(e.target as HTMLElement).closest('button,a')) onOpen(task.id); }}>
      {tbl.cols.map((c) => { const p = pin(c, false, tbl.cols); return <div key={c.id} data-col={c.id} className={`min-w-0 px-2 ${p.className}`} style={p.style}>{cell(c.id)}</div>; })}
    </div>
  );
}

const BOARD_EMPTY = { mine: '' };
const LIST_EMPTY = { q: '' };

export function MyWork() {
  const { t, i18n } = useTranslation();
  const me = useMe(true);
  const [open, setOpen] = useState<string | null>(null);
  // F5 (0.15.32): List (the three buckets) or Board (the tasks board by approval state); the layout, the "mine" switch and the F3 tree live in the URL
  const [sp, setSp] = useSearchParams();
  const board = sp.get('layout') === 'board';
  const mine = sp.get('mine') === 'true';
  const adv = sp.get('adv') ?? '';
  const advTree = decodeFilter(adv);
  // W8: the search (one word, or a pasted list of Site IDs) goes to the server with the + Filter tree; the counts come back from it
  const q = sp.get('q') ?? '';
  const setParams = (kv: Record<string, string>) => setSp((prev) => { const n = new URLSearchParams(prev); for (const [k, v] of Object.entries(kv)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  const f = { q, filter: adv || undefined };
  const late = useMyTasks('late', f), doNow = useMyTasks('do_now', f), waiting = useMyTasks('waiting', f);
  const qs = { late, do_now: doNow, waiting } as const;
  const total = [late, doNow, waiting].reduce((n, x) => n + (x.data?.items.length ?? 0), 0);
  const screenTotal = [late, doNow, waiting].reduce((n, x) => n + (x.data?.counts?.total ?? x.data?.items.length ?? 0), 0);
  const filtered = [late, doNow, waiting].reduce((n, x) => n + (x.data?.counts?.filtered ?? x.data?.items.length ?? 0), 0);
  const loaded = [late, doNow, waiting].every((x) => x.isSuccess);
  const active = !!(q.trim() || adv);
  const tbl = useTablePrefs('my-work', DEFS);
  const label = (id: string) => t(LABEL[id] ?? id);
  const clearAll = () => setParams({ q: '', adv: '' });
  const myViews: ViewOption[] = [
    { id: 'list', label: t('board.list'), hint: t('view.mywork_list_hint'), icon: <List size={14} />, testid: 'my-work-layout-list' },
    { id: 'board', label: t('board.board'), hint: t('view.mywork_board_hint'), icon: <Columns3 size={14} />, testid: 'my-work-layout-board' },
  ];
  // V7: one Layout panel for My Work, as on every screen — the list/board switcher and, while the list is on, the Display options
  const switcher = <LayoutPanel testid="my-work-view" views={{ value: board ? 'board' : 'list', options: myViews, onChange: (id) => setParams({ layout: id === 'board' ? 'board' : '' }) }} table={board ? undefined : tbl} />;
  let n = 0;
  return (
    <div className="space-y-4" data-testid="page-my-work">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('myWork.title')}</h1>
          <p className="text-mute">{t('myWork.hello', { name: me.data?.user.display_name.split(' ')[0] ?? '' })}</p>
        </div>
        <button type="button" className="btn ms-auto" data-testid="my-work-ics" onClick={() => { void downloadFile('/me/tasks.ics').catch(() => undefined); }}><CalendarDays size={16} />{t('myWork.ics')}</button>
        <Link to="/approvals" data-testid="my-work-go-approvals" className="btn btn-accent"><Inbox size={16} />{t('myWork.go_approvals')}<span className="chip bg-card text-ink">{doNow.data?.items.length ?? 0}</span></Link>
      </div>
      <MyWorkCalendar late={late.data?.items ?? []} doNow={doNow.data?.items ?? []} onOpen={setOpen} />
      {board ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2" data-testid="tasks-board-toolbar">
            <SavedViews screen="tasks-board" value={{ mine: mine ? 'true' : '', ...(advTree ? { advanced: advTree } : {}) }} empty={BOARD_EMPTY}
              onApply={(v) => setParams({ mine: String((v as Record<string, unknown>).mine ?? ''), adv: encodeFilter((v as { advanced?: FilterTree }).advanced) })} />
            <UnifiedFilter screen="tasks-board" value={advTree} onChange={(tree) => setParams({ adv: encodeFilter(tree) })} onClearAll={() => setParams({ adv: '', mine: '' })}
              extras={[{ key: 'mine', label: t('board.mine'), group: 'work', kind: 'bool', value: mine ? '1' : '', set: (v) => setParams({ mine: v ? 'true' : '' }) }]} />
            <span className="ms-auto">{switcher}</span>
          </div>
          <TasksBoard query={{ filter: adv || undefined, mine: mine || undefined }} />
        </div>
      ) : (<>
      <TableToolbar testid="my-work-toolbar"
        views={<SavedViews screen="my-work" value={{ q, ...(advTree ? { advanced: advTree } : {}) }} empty={LIST_EMPTY} table={tbl}
          onApply={(v) => setParams({ q: String((v as Record<string, unknown>).q ?? ''), adv: encodeFilter((v as { advanced?: FilterTree }).advanced) })} />}
        search={<SearchBox testid="my-work-search" value={q} onChange={(v) => setParams({ q: v })} />}
        filter={<UnifiedFilter screen="tasks-board" value={advTree} onChange={(tree) => setParams({ adv: encodeFilter(tree) })} onClearAll={clearAll} />}
        extra={<PastedChip search={late.data?.search ?? doNow.data?.search ?? waiting.data?.search} />}
        count={<TableCount testid="my-work-count" noun="tasks" total={screenTotal} filtered={filtered} active={active} onClear={clearAll} />}
        columns={<ColumnMenu api={tbl} label={label} />}
        layout={switcher}
        exporter={<ExportCsvButton testid="my-work-export" name="my-work" head={['#', t('approvals.bucket'), label('site'), t('grid.code'), label('task'), label('sla')]}
          rows={() => { let i = 0; return BUCKETS.flatMap(([k]) => (qs[k].data?.items ?? []).map((x) => [++i, t(`myWork.${k}`), x.site_code, x.task_code, (i18n.language === 'ar' && x.name_ar) || x.name_en, x.sla?.colour ?? ''])); }} />} />
      <div className="card gx overflow-auto" {...displayAttrs(tbl.display)} data-testid="my-work-table">
        <div className="sticky top-0 z-20"><HeaderRow api={tbl} label={label} testid="my-work-head" /></div>
        <div role="list" style={{ minWidth: totalWidth(tbl.cols, false) }}>
          {BUCKETS.map(([id, Icon]) => {
            const items = qs[id].data?.items ?? [];
            return (
              <Fragment key={id}>
                <section data-testid={`my-work-bucket-${id}`} aria-label={t(`myWork.${id}`)}>
                  <h2 className="flex items-center gap-2 border-b border-line bg-card2 px-3 py-2 text-sm font-bold"><Icon size={16} />{t(`myWork.${id}`)}
                    <span className="chip border border-line" data-testid={`my-work-count-${id}`}>{qs[id].data?.counts?.filtered ?? items.length}</span></h2>
                  {items.length ? items.map((x) => <Row key={x.id} task={x} n={++n} tbl={tbl} onOpen={setOpen} />) : <p className="p-3 text-center text-sm text-mute">{t('myWork.nothing')}</p>}
                </section>
              </Fragment>
            );
          })}
        </div>
      </div>
      <TaskDrawer taskId={open} onClose={() => setOpen(null)} />
      {loaded && total === 0 && !active && (
        <div className="card p-10 text-center" data-testid="my-work-empty"><Check className="mx-auto" /><h2 className="font-bold">{t('myWork.empty_title')}</h2><p className="text-mute">{t('myWork.empty_body')}</p></div>
      )}
      </>)}
    </div>
  );
}
