import { useQueryClient } from '@tanstack/react-query';
import { Building2, Hourglass } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSitesBoard, type SiteBoardCard, type SitesBoard as Board } from '@/api/boards';
import { useRegions } from '@/api/sites';
import { api } from '@/api/client';
import type { SiteTasks, TaskDetail } from '@/api/types';
import { BoardGrid } from './Board';
import { intentFor } from './TasksBoard';
import { TaskDrawer, type DrawerIntent } from './TaskDrawer';
import { useToast } from './Toast';

/**
 * F5 (contract 0.15.32): the sites board of Site Master, read only. One column per milestone plus Closed; a site sits in the first milestone
 * it has not reached, the server decides it. Swimlanes by region or contractor; the ageing is in working days (the server counts them);
 * a WIP limit only shows a warning. Nothing can be dragged: a card is a link to the site, so a site moves only through its own tasks (a drop or the Open action button only opens the task's own action).
 */
export const SWIMLANES = ['none', 'region', 'contractor'] as const;
export type Swimlane = (typeof SWIMLANES)[number];

const STATUS_TONE: Record<string, string> = { completed: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', on_hold: 'bg-waitBg text-waitInk', not_started: 'bg-lockBg text-lockInk', cancelled: 'bg-lateBg text-lateInk' };
const SLA_TONE: Record<string, string> = { green: 'bg-doneBg text-doneInk', amber: 'bg-waitBg text-waitInk', red: 'bg-lateBg text-lateInk' };

function Card({ c, region, column, onOpenAction }: { c: SiteBoardCard; region: string; column: string; onOpenAction: (c: SiteBoardCard, column: string) => void }) {
  const { t, i18n } = useTranslation();
  const name = (i18n.language === 'ar' && c.name_ar) || c.name;
  return (
    <div draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ id: c.id, column })); e.dataTransfer.effectAllowed = 'move'; }}>
    <Link to={`/sites/${c.id}`} data-testid={`board-site-${c.site_code}`} data-ageing={c.ageing_wd}
        className="block rounded-md border border-line bg-card p-2 text-sm hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={t('board.site_card', { code: c.site_code, name, days: c.ageing_wd })}>
        <div className="flex items-baseline gap-2"><b className="mono" dir="ltr">{c.site_code}</b><span className="truncate">{name}</span></div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-mute">
          <span>{region}</span>
          {c.contractor && <span className="inline-flex items-center gap-1" data-testid={`board-site-party-${c.site_code}`}><Building2 size={12} aria-hidden />{c.contractor.name}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
          <span className={`chip ${STATUS_TONE[c.overall_status] ?? ''}`}>{t(`status.${c.overall_status}`)}</span>
          <span className="chip bg-card2" data-testid={`board-site-age-${c.site_code}`} title={t('board.ageing_title', { date: c.entered_on })}>
            <Hourglass size={12} aria-hidden className="me-1" />{t('board.ageing', { count: c.ageing_wd })}
          </span>
          {c.sla_colour && <span className={`chip ${SLA_TONE[c.sla_colour]}`} data-testid={`board-site-sla-${c.site_code}`} data-colour={c.sla_colour}>{t(`board.sla_${c.sla_colour}`)}</span>}
          {(c.at_l1 > 0 || c.at_l2 > 0) && <span className="chip border border-line" title={t('board.ball_title')}>{t('board.ball', { l1: c.at_l1, l2: c.at_l2 })}</span>}
        </div>
    </Link>
    {column !== 'closed' && <button type="button" className="mt-1 text-xs text-accentText underline" data-testid={`board-site-action-${c.site_code}`} onClick={() => onOpenAction(c, column)}>{t('board.open_action')}</button>}
    </div>
  );
}

/** `query` holds the filters of the Site Master list (the F3 tree as `filter`), so the board and the list show the same sites. The swimlane is
 *  chosen in the screen's Layout panel (decision V1); the board only draws it. */
export function SitesBoard({ query, swimlane }: { query: Record<string, string | undefined>; swimlane: Swimlane }) {
  const { t, i18n } = useTranslation();
  const regions = useRegions();
  const q = useSitesBoard({ ...query, swimlane });
  const b: Board | undefined = q.data;
  const ar = i18n.language === 'ar';
  const rname = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (ar && r?.name_ar) || r?.name_en || String(id); };
  const colName = (c: Board['columns'][number]) => (c.kind === 'closed' ? t('board.closed') : (ar && c.name_ar) || t(`stage.${c.key}`, { defaultValue: c.name_en }));
  const laneName = (l: Board['lanes'][number]) => (swimlane === 'region' ? rname(Number(l.key)) : l.key === 'none' ? t('board.no_contractor') : l.key === 'all' ? t('board.all_sites') : (ar && l.label_ar) || l.label_en);
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState<{ id: string; intent?: DrawerIntent } | null>(null);
  const [pick, setPick] = useState<{ site: string; items: { id: string; name: string; intent: DrawerIntent }[] } | null>(null);
  /** A card moves one column on, and only through the existing task action: the tasks of the milestone the card sits in are read, the server's `allowed_actions` decide which one may run, and the usual drawer asks for the confirmation. */
  const moveCard = async (siteId: string, siteCode: string, from: string, to: string) => {
    const cols = b?.columns ?? [];
    const i = cols.findIndex((x) => x.key === from);
    if (i < 0 || cols[i + 1]?.key !== to) { toast(t('board.site_next_only'), 'err'); return; }
    try {
      const st = await qc.fetchQuery({ queryKey: ['site-tasks', siteId, '', '', ''], queryFn: () => api.get<SiteTasks>(`/sites/${siteId}/tasks`), staleTime: 0 });
      const tasks = st.stages.find((x) => x.code === from)?.tasks ?? [];
      const found: { id: string; name: string; intent: DrawerIntent }[] = [];
      for (const k of tasks) {
        const d = await qc.fetchQuery({ queryKey: ['task', k.id], queryFn: () => api.get<TaskDetail>(`/tasks/${k.id}`), staleTime: 0 });
        const intent = intentFor('approved', d.allowed_actions) ?? intentFor('review', d.allowed_actions);
        if (intent) found.push({ id: k.id, name: (ar && k.name_ar) || k.name_en, intent });
      }
      if (!found.length) { toast(t('board.site_drop_refused', { code: siteCode }), 'err'); return; }
      if (found.length === 1) setOpen({ id: found[0]!.id, intent: found[0]!.intent });
      else setPick({ site: siteCode, items: found });
    } catch { toast(t('common.error'), 'err'); }
  };
  const nextOf = (from: string) => { const cols = b?.columns ?? []; return cols[cols.findIndex((x) => x.key === from) + 1]?.key ?? ''; };
  const onDropTo = (col: string, _lane: string, e: DragEvent) => {
    try {
      const d = JSON.parse(e.dataTransfer.getData('text/plain')) as { id: string; column: string };
      const card = b?.cells.flatMap((x) => x.cards).find((x) => x.id === d.id);
      if (card && d.column !== col) void moveCard(card.id, card.site_code, d.column, col);
    } catch { /* not a card */ }
  };
  const moreLink = (col: string) => (col === 'closed' ? '/sites?bucket=closed' : `/sites?stage_code=${encodeURIComponent(col)}`);

  return (
    <section className="space-y-2" data-testid="sites-board" aria-label={t('board.sites_title')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-mute" data-testid="sites-board-total">{t('sites.count', { count: b?.total ?? 0 })}</span>
        <span className="ms-auto text-xs text-mute" data-testid="sites-board-note">{t('board.sites_drop_note')}</span>
      </div>
      {q.isError && <p role="alert" className="text-sm text-lateInk" data-testid="sites-board-error">{t('errors.generic')}</p>}
      {pick && (
        <div role="dialog" aria-label={t('board.site_pick_title', { code: pick.site })} className="card space-y-1 p-3 text-sm" data-testid="sites-board-pick">
          <b>{t('board.site_pick_title', { code: pick.site })}</b>
          <ul className="space-y-1">{pick.items.map((x) => <li key={x.id}><button type="button" className="btn" data-testid={`sites-board-pick-${x.id}`} onClick={() => { setOpen({ id: x.id, intent: x.intent }); setPick(null); }}>{x.name}</button></li>)}</ul>
          <button type="button" className="btn" onClick={() => setPick(null)}>{t('common.cancel')}</button>
        </div>
      )}
      {b && (
        <BoardGrid onDropTo={onDropTo} testid="sites-board-scroll" emptyTestid="sites-board-empty" empty={t('board.empty')} total={b.total} showLanes={swimlane !== 'none'}
          columns={b.columns.map((c) => ({ key: c.key, name: colName(c), count: c.count, wip: c.wip_limit !== null ? { limit: c.wip_limit, over: !!c.over_wip, text: c.over_wip ? t('board.wip_over', { count: c.count, limit: c.wip_limit }) : t('board.wip_limit', { limit: c.wip_limit }) } : null }))}
          lanes={b.lanes.map((l) => ({ key: l.key, name: laneName(l), count: l.count }))}
          label={(c, l) => `${c.name} · ${l.name}`}
          cell={(col, lane) => {
            const x = b.cells.find((y) => y.column === col && y.lane === lane);
            return x ? { cards: x.cards, more: x.more ? <Link className="mt-1 block text-xs text-accentText underline" to={moreLink(col)} data-testid={`board-more-${col}-${lane}`}>{t('board.more', { count: x.count - x.cards.length })}</Link> : undefined } : undefined;
          }}
          cardKey={(x) => x.id} card={(x) => { const col = b.cells.find((y) => y.cards.some((z) => z.id === x.id))?.column ?? ''; return <Card c={x} region={rname(x.region_id)} column={col} onOpenAction={(cc, from) => void moveCard(cc.id, cc.site_code, from, nextOf(from))} />; }} />
      )}
      <TaskDrawer taskId={open?.id ?? null} intent={open?.intent} onClose={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ['boards', 'sites'] }); }} />
    </section>
  );
}
