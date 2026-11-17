import { AlertTriangle, Building2, Hourglass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSitesBoard, type SiteBoardCard, type SitesBoard as Board } from '@/api/boards';
import { useRegions } from '@/api/sites';

/**
 * F5 (contract 0.15.32): the sites board of SITE 360, read only. One column per milestone plus Closed; a site sits in the first milestone
 * it has not reached, the server decides it. Swimlanes by region or contractor; the ageing is in working days (the server counts them);
 * a WIP limit only shows a warning. Nothing can be dragged: a card is a link to the site, so a site moves only through its own tasks.
 */
export const SWIMLANES = ['none', 'region', 'contractor'] as const;
export type Swimlane = (typeof SWIMLANES)[number];

const STATUS_TONE: Record<string, string> = { completed: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', on_hold: 'bg-waitBg text-waitInk', not_started: 'bg-lockBg text-lockInk', cancelled: 'bg-lateBg text-lateInk' };
const SLA_TONE: Record<string, string> = { green: 'bg-doneBg text-doneInk', amber: 'bg-waitBg text-waitInk', red: 'bg-lateBg text-lateInk' };

function Card({ c, region }: { c: SiteBoardCard; region: string }) {
  const { t, i18n } = useTranslation();
  const name = (i18n.language === 'ar' && c.name_ar) || c.name;
  return (
    <li>
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
    </li>
  );
}

/** `query` holds the filters of the SITE 360 list (the F3 tree as `filter`), so the board and the list show the same sites. */
export function SitesBoard({ query, swimlane, onSwimlane }: { query: Record<string, string | undefined>; swimlane: Swimlane; onSwimlane: (s: Swimlane) => void }) {
  const { t, i18n } = useTranslation();
  const regions = useRegions();
  const q = useSitesBoard({ ...query, swimlane });
  const b: Board | undefined = q.data;
  const ar = i18n.language === 'ar';
  const rname = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (ar && r?.name_ar) || r?.name_en || String(id); };
  const colName = (c: Board['columns'][number]) => (c.kind === 'closed' ? t('board.closed') : (ar && c.name_ar) || t(`stage.${c.key}`, { defaultValue: c.name_en }));
  const laneName = (l: Board['lanes'][number]) => (swimlane === 'region' ? rname(Number(l.key)) : l.key === 'none' ? t('board.no_contractor') : l.key === 'all' ? t('board.all_sites') : (ar && l.label_ar) || l.label_en);
  const moreLink = (col: string) => (col === 'closed' ? '/sites?bucket=closed' : `/sites?stage_code=${encodeURIComponent(col)}`);

  return (
    <section className="space-y-2" data-testid="sites-board" aria-label={t('board.sites_title')}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm"><span className="text-mute">{t('board.swimlane')}</span>
          <select className="input w-auto py-1" data-testid="sites-board-swimlane" value={swimlane} onChange={(e) => onSwimlane(e.target.value as Swimlane)}>
            {SWIMLANES.map((s) => <option key={s} value={s}>{t(`board.lane_${s}`)}</option>)}
          </select>
        </label>
        <span className="text-sm text-mute" data-testid="sites-board-total">{t('sites.count', { count: b?.total ?? 0 })}</span>
        <span className="ms-auto text-xs text-mute">{t('board.read_only')}</span>
      </div>
      {q.isError && <p role="alert" className="text-sm text-lateInk">{t('common.error')}</p>}
      {b && (
        <div className="overflow-auto" data-testid="sites-board-scroll">
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${b.columns.length}, minmax(220px, 1fr))` }}>
            {b.columns.map((c) => (
              <div key={c.key} data-testid={`board-col-${c.key}`} data-over-wip={c.over_wip || undefined}
                className={`sticky top-0 z-10 rounded-md border p-2 text-sm ${c.over_wip ? 'border-waitInk bg-waitBg' : 'border-line bg-card2'}`}>
                <div className="flex items-center gap-2 font-semibold"><span className="truncate">{colName(c)}</span><span className="chip ms-auto border border-line" data-testid={`board-col-count-${c.key}`}>{c.count}</span></div>
                {c.wip_limit !== null && (
                  <div className={`mt-1 flex items-center gap-1 text-xs ${c.over_wip ? 'text-waitInk' : 'text-mute'}`} data-testid={`board-col-wip-${c.key}`} role={c.over_wip ? 'note' : undefined}>
                    {c.over_wip && <AlertTriangle size={12} aria-hidden />}{c.over_wip ? t('board.wip_over', { count: c.count, limit: c.wip_limit }) : t('board.wip_limit', { limit: c.wip_limit })}
                  </div>
                )}
              </div>
            ))}
            {b.lanes.map((l) => (
              <div key={l.key} className="contents" data-testid={`board-lane-${l.key}`}>
                {swimlane !== 'none' && <h3 className="col-span-full mt-2 border-b border-line pb-1 text-sm font-bold" data-testid={`board-lane-title-${l.key}`}>{laneName(l)} <span className="font-normal text-mute">({l.count})</span></h3>}
                {b.columns.map((c) => {
                  const cell = b.cells.find((x) => x.column === c.key && x.lane === l.key);
                  return (
                    <div key={c.key} className="min-h-12 rounded-md bg-card2/40 p-1" data-testid={`board-cell-${c.key}-${l.key}`}>
                      <ul className="space-y-1" aria-label={`${colName(c)} · ${laneName(l)}`}>
                        {cell?.cards.map((x) => <Card key={x.id} c={x} region={rname(x.region_id)} />)}
                      </ul>
                      {cell?.more && <Link className="mt-1 block text-xs text-accentText underline" to={moreLink(c.key)} data-testid={`board-more-${c.key}-${l.key}`}>{t('board.more', { count: cell.count - cell.cards.length })}</Link>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {b.total === 0 && <p className="p-6 text-center text-mute" data-testid="sites-board-empty">{t('board.empty')}</p>}
        </div>
      )}
    </section>
  );
}
