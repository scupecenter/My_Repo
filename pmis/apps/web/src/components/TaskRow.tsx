import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SiteTasks } from '@/api/types';
import { STATE_TONE } from './TaskGrid';

/** Owner request 2026-11-08: the site's stages and tasks side by side, like one Master row in Excel. Clicking a task opens its drawer. */
export function TaskRow({ stages, onOpen, selected, onVisible }: { stages: SiteTasks['stages']; onOpen: (id: string) => void; selected?: string | null; onVisible?: (ids: string[]) => void }) {
  const { t, i18n } = useTranslation();
  const tasks = stages.flatMap((s) => s.tasks);
  const ids = tasks.map((x) => x.id).join(',');
  useEffect(() => { onVisible?.(ids ? ids.split(',') : []); }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (x: (typeof tasks)[number]) => (i18n.language === 'ar' && x.name_ar) || x.name_en || x.task_code;
  // the look of the Site Master and register tables (shared .gx classes): tinted sticky header band, opaque frozen first column, zebra rows, hover, framed card
  const head = 'sticky start-0 z-20 gx-frozen-end px-3 py-2 text-start text-xs font-semibold text-mute bg-inherit';
  const cell = (x: (typeof tasks)[number], body: ReactNode) => (
    <td key={x.id} data-col={x.id} className={`border-s border-line px-3 py-2 ${selected === x.id ? 'bg-sideOn' : ''}`}>
      <button type="button" className="w-full rounded text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => onOpen(x.id)}>{body}</button>
    </td>
  );
  const dash = <span className="text-mute">—</span>;
  const date = (d?: string | null) => (d ? <span className="mono" dir="ltr">{d}</span> : dash);
  if (!tasks.length) return <p className="card p-6 text-mute">{t('site.no_tasks')}</p>;
  return (
    <div className="card gx max-h-[70vh] overflow-auto" data-testid="task-row">
      <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-30">
          <tr className="gx-head">
            <th className={`${head} bg-[var(--gx-head)]`} />
            {stages.filter((s) => s.tasks.length).map((s) => (
              <th key={s.code} colSpan={s.tasks.length} data-testid={`row-stage-${s.code}`} className="border-s border-line px-3 py-2 text-start font-semibold">{(i18n.language === 'ar' && s.name_ar) || s.name_en}</th>
            ))}
          </tr>
          <tr className="gx-head">
            <th className={`${head} bg-[var(--gx-head)]`}>{t('grid.task')}</th>
            {tasks.map((x) => (
              <th key={x.id} title={name(x)} className="min-w-[140px] max-w-[190px] border-s border-t border-line px-3 py-2 text-start align-top">
                <button type="button" className="text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" data-testid={`row-open-${x.id}`} onClick={() => onOpen(x.id)}>
                  <span className="mono block font-bold">{x.task_code}</span><span className="line-clamp-2 text-xs font-normal text-mute">{name(x)}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="gx-row border-t border-line" data-zebra="0"><th className={head}>{t('grid.status')}</th>{tasks.map((x) => cell(x, <span className={`chip ${STATE_TONE[x.state] ?? ''}`}>{t(`taskState.${x.state}`)}</span>))}</tr>
          <tr className="gx-row border-t border-line" data-zebra="1"><th className={head}>{t('grid.plan')}</th>{tasks.map((x) => cell(x, date(x.planned_date)))}</tr>
          <tr className="gx-row border-t border-line" data-zebra="0"><th className={head}>{t('grid.actual')}</th>{tasks.map((x) => cell(x, date(x.actual_date)))}</tr>
        </tbody>
      </table>
    </div>
  );
}
