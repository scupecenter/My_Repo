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
  const head = 'sticky start-0 z-10 bg-card2 px-2 py-1 text-start text-xs font-semibold text-mute';
  const cell = (x: (typeof tasks)[number], body: ReactNode) => (
    <td key={x.id} className={`border-s border-line px-2 py-1 ${selected === x.id ? 'bg-sideOn' : ''}`}>
      <button type="button" className="w-full text-start" onClick={() => onOpen(x.id)}>{body}</button>
    </td>
  );
  if (!tasks.length) return <p className="card p-6 text-mute">{t('site.no_tasks')}</p>;
  return (
    <div className="card overflow-x-auto" data-testid="task-row">
      <table className="border-collapse text-sm">
        <thead>
          <tr className="border-b border-line">
            <th className={head} />
            {stages.filter((s) => s.tasks.length).map((s) => (
              <th key={s.code} colSpan={s.tasks.length} data-testid={`row-stage-${s.code}`} className="border-s border-line bg-card2 px-2 py-1 text-start font-semibold">{(i18n.language === 'ar' && s.name_ar) || s.name_en}</th>
            ))}
          </tr>
          <tr className="border-b border-line">
            <th className={head}>{t('grid.task')}</th>
            {tasks.map((x) => (
              <th key={x.id} title={name(x)} className="min-w-[130px] max-w-[180px] border-s border-line px-2 py-1 text-start align-top">
                <button type="button" className="text-start" data-testid={`row-open-${x.id}`} onClick={() => onOpen(x.id)}>
                  <span className="mono block font-bold">{x.task_code}</span><span className="line-clamp-2 text-xs font-normal text-mute">{name(x)}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-line"><th className={head}>{t('grid.status')}</th>{tasks.map((x) => cell(x, <span className={`chip ${STATE_TONE[x.state] ?? ''}`}>{t(`taskState.${x.state}`)}</span>))}</tr>
          <tr className="border-b border-line"><th className={head}>{t('grid.plan')}</th>{tasks.map((x) => cell(x, <span className="mono" dir="ltr">{x.planned_date ?? '—'}</span>))}</tr>
          <tr><th className={head}>{t('grid.actual')}</th>{tasks.map((x) => cell(x, <span className="mono" dir="ltr">{x.actual_date ?? '—'}</span>))}</tr>
        </tbody>
      </table>
    </div>
  );
}
