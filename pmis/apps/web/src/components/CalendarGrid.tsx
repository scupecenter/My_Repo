import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { monthGrid, type DayItem } from '@/lib/monthGrid';

/**
 * The shared month calendar (decision V2): any screen hands it dated items and it draws the month grid, EN/AR with localized month and
 * weekday names (the grid itself stays LTR). Items with no valid date are counted apart, never dropped silently.
 */
export function CalendarGrid({ testid, items, onOpen, head }: {
  testid: string;
  items: DayItem[];
  onOpen: (id: string) => void;
  /** an optional line above the grid (the screen's own status or legend) */
  head?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });
  const g = monthGrid(ym.y, ym.m, items, 6);
  const step = (d: number) => setYm((p) => { const n = new Date(p.y, p.m - 1 + d, 1); return { y: n.getFullYear(), m: n.getMonth() + 1 }; });
  const title = new Date(ym.y, ym.m - 1, 1).toLocaleDateString(i18n.language === 'ar' ? 'ar' : 'en', { month: 'long', year: 'numeric' });
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 10, 7 + i)).toLocaleDateString(i18n.language === 'ar' ? 'ar' : 'en', { weekday: 'short', timeZone: 'UTC' }));
  return (
    <div data-testid={testid}>
      <div className="mb-2 flex items-center gap-2">
        <button type="button" className="btn px-2 py-1" aria-label={t('calview.prev')} data-testid={`${testid}-prev`} onClick={() => step(-1)}><ChevronLeft size={14} /></button>
        <b data-testid={`${testid}-title`}>{title}</b>
        <button type="button" className="btn px-2 py-1" aria-label={t('calview.next')} data-testid={`${testid}-next`} onClick={() => step(1)}><ChevronRight size={14} /></button>
        {g.undated > 0 && <span className="ms-auto text-xs text-mute" data-testid={`${testid}-undated`}>{t('calview.undated', { n: g.undated })}</span>}
        {head}
      </div>
      <div className="grid grid-cols-7 gap-px text-xs" role="grid" dir="ltr">
        {weekdays.map((h) => <div key={h} className="p-1 text-center font-semibold text-mute">{h}</div>)}
        {g.cells.map((c) => (
          <div key={c.date} role="gridcell" data-date={c.date} className={`min-h-16 bg-card2 p-1 ${c.inMonth ? '' : 'opacity-40'}`}>
            <div className="tnum text-mute">{Number(c.date.slice(8))}</div>
            {c.items.slice(0, 3).map((i) => (
              <button key={i.id} type="button" onClick={() => onOpen(i.id)} title={i.label} className={`mt-0.5 block w-full truncate rounded px-1 text-start ${i.late ? 'bg-lateBg text-lateInk' : 'bg-openBg text-openInk'}`} data-testid={`${testid}-item`}>{i.label}</button>
            ))}
            {c.items.length > 3 && <div className="text-mute">+{c.items.length - 3}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
