import { useTranslation } from 'react-i18next';
import type { TaskSummary } from '@/api/types';
import { CalendarGrid } from './CalendarGrid';

/** Month view of my open tasks on their SLA due date (or planned date). Read only: it shows what My Work already returned for this person. */
export function MyWorkCalendar({ late, doNow, onOpen }: { late: TaskSummary[]; doNow: TaskSummary[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const items = [
    ...late.map((x) => ({ x, late: true })),
    ...doNow.map((x) => ({ x, late: false })),
  ].map(({ x, late: l }) => ({ id: x.id, label: `${x.site_code} ${x.name_en}`, date: x.sla?.due_date ?? x.planned_date ?? '', late: l }));
  return (
    <details className="card p-3" data-testid="my-work-calendar">
      <summary className="cursor-pointer text-sm font-semibold">{t('myWorkCal.title')}</summary>
      <div className="mt-2">
        <CalendarGrid testid="cal" items={items} onOpen={onOpen} />
      </div>
    </details>
  );
}
