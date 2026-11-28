import { useTranslation } from 'react-i18next';
import { daysUntil, dueTone, relativeDue, type DueTone } from '@/lib/relativeDue';
import { fmtDate } from '@/lib/time';
import { useExtra } from '@/lib/uiExtras';

const TONE: Record<DueTone, string> = { late: 'bg-lateBg text-lateInk', soon: 'bg-waitBg text-waitInk', near: 'bg-openBg text-openInk', far: 'bg-lockBg text-lockInk' };

/**
 * A due date said the way people say it ("tomorrow", "2 days ago") in a colour: overdue red, today to 2 days amber, within a week blue, later quiet.
 * It sits beside the exact date, never replaces it, and the tooltip carries the exact date. `done` (a finished task) shows nothing, it is not due any more.
 * A person can switch it off in Settings > Screens > Interface > "On this device".
 */
export function RelDue({ date, done = false, testid }: { date: string | null | undefined; done?: boolean; testid?: string }) {
  const { t, i18n } = useTranslation();
  const on = useExtra('relative_due');
  const days = date ? daysUntil(date) : null;
  if (!on || done || days === null || !date) return null;
  const tone = dueTone(days);
  return (
    <span className={`chip ${TONE[tone]}`} data-testid={testid ?? 'rel-due'} data-tone={tone} data-days={days} title={`${t('reldue.title')}: ${fmtDate(date, i18n.language)}`}>
      <bdi>{relativeDue(days, i18n.language)}</bdi>
    </span>
  );
}
