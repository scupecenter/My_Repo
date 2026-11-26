import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskSummary } from '@/api/types';
import { monthGrid, type DayItem } from '@/lib/monthGrid';

/** Month view of my open tasks on their SLA due date (or planned date). Read only: it shows what My Work already returned for this person. */
export function MyWorkCalendar({ late, doNow, onOpen }: { late: TaskSummary[]; doNow: TaskSummary[]; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });
  const items: DayItem[] = [
    ...late.map((x) => ({ x, late: true })),
    ...doNow.map((x) => ({ x, late: false })),
  ].map(({ x, late: l }) => ({ id: x.id, label: `${x.site_code} ${x.name_en}`, date: x.sla?.due_date ?? x.planned_date ?? '', late: l }));
  const g = monthGrid(ym.y, ym.m, items, 6);
  const step = (d: number) => setYm((p) => { const n = new Date(p.y, p.m - 1 + d, 1); return { y: n.getFullYear(), m: n.getMonth() + 1 }; });
  const title = new Date(ym.y, ym.m - 1, 1).toLocaleDateString(i18n.language === 'ar' ? 'ar' : 'en', { month: 'long', year: 'numeric' });
  const head = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 10, 7 + i)).toLocaleDateString(i18n.language === 'ar' ? 'ar' : 'en', { weekday: 'short', timeZone: 'UTC' }));
  return (
    <details className="card p-3" data-testid="my-work-calendar">
      <summary className="cursor-pointer text-sm font-semibold">{t('myWorkCal.title')}</summary>
      <div className="mb-2 mt-2 flex items-center gap-2">
        <button type="button" className="btn px-2 py-1" aria-label={t('myWorkCal.prev')} data-testid="cal-prev" onClick={() => step(-1)}><ChevronLeft size={14} /></button>
        <b data-testid="cal-title">{title}</b>
        <button type="button" className="btn px-2 py-1" aria-label={t('myWorkCal.next')} data-testid="cal-next" onClick={() => step(1)}><ChevronRight size={14} /></button>
        {g.undated > 0 && <span className="ms-auto text-xs text-mute" data-testid="cal-undated">{t('myWorkCal.undated', { n: g.undated })}</span>}
      </div>
      <div className="grid grid-cols-7 gap-px text-xs" role="grid" dir="ltr">
        {head.map((h) => <div key={h} className="p-1 text-center font-semibold text-mute">{h}</div>)}
        {g.cells.map((c) => (
          <div key={c.date} role="gridcell" data-date={c.date} className={`min-h-16 bg-card2 p-1 ${c.inMonth ? '' : 'opacity-40'}`}>
            <div className="tnum text-mute">{Number(c.date.slice(8))}</div>
            {c.items.slice(0, 3).map((i) => (
              <button key={i.id} type="button" onClick={() => onOpen(i.id)} title={i.label} className={`mt-0.5 block w-full truncate rounded px-1 text-start ${i.late ? 'bg-lateBg text-lateInk' : 'bg-openBg text-openInk'}`} data-testid="cal-item">{i.label}</button>
            ))}
            {c.items.length > 3 && <div className="text-mute">+{c.items.length - 3}</div>}
          </div>
        ))}
      </div>
    </details>
  );
}
