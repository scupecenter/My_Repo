import { useTranslation } from 'react-i18next';
import { Tip } from './Tip';

export type SummarySegment = { key: string; label: string; count: number; tone: string };

/**
 * Item 9: the summary of a group header of a grouped table: the count, and a bar with one segment per status, as wide as its share of the group.
 * Every segment is a button that filters the table to that status (a second click clears it, `aria-pressed` says which is on); the text alternative
 * is the same numbers as a list for a screen reader, and each segment has a tooltip. The bar is drawn only while the screen's Display option
 * "Group summary" is on (Settings > Screens > Tables for the default, the Layout panel for the person's own choice), so a screen without it shows the
 * plain header it had. Colours come from the status tones the app already uses; the segment order is the order of `segments`.
 */
export function GroupSummary({ testid, group, segments, active, onPick, show, label }: {
  testid: string;
  /** the group's name, for the text alternative */
  group: string;
  segments: SummarySegment[];
  /** the segment key now filtering the table, or null */
  active: string | null;
  onPick: (key: string | null) => void;
  show: boolean;
  /** the text alternative of the whole bar, when "tasks" is not the right noun (the pivot table counts records) */
  label?: string;
}) {
  const { t } = useTranslation();
  const total = segments.reduce((n, s) => n + s.count, 0);
  if (!show || total === 0) return null;
  const parts = segments.filter((s) => s.count > 0);
  return (
    <span className="ms-auto flex min-w-0 items-center gap-2" data-testid={testid} role="group" aria-label={label ?? t('gsum.label', { total, group })}>
      <span className="flex h-3 w-40 overflow-hidden rounded-full border border-line bg-card" data-testid={`${testid}-bar`}>
        {parts.map((s) => (
          <Tip key={s.key} text={t('gsum.segment_hint', { label: s.label, count: s.count })}>
            <button type="button" aria-pressed={active === s.key} aria-label={t('gsum.segment', { label: s.label, count: s.count })} data-testid={`${testid}-seg-${s.key}`}
              className={`h-full min-w-[6px] ${s.tone} ${active === s.key ? 'outline outline-2 -outline-offset-2 outline-accent' : ''} ${active && active !== s.key ? 'opacity-40' : ''}`}
              style={{ width: `${(s.count / total) * 100}%` }} onClick={() => onPick(active === s.key ? null : s.key)} />
          </Tip>
        ))}
      </span>
      <ul className="sr-only" data-testid={`${testid}-text`}>{parts.map((s) => <li key={s.key}>{t('gsum.segment', { label: s.label, count: s.count })}</li>)}</ul>
      {active && <button type="button" className="text-xs text-link" data-testid={`${testid}-clear`} onClick={() => onPick(null)}>{t('gsum.clear')}</button>}
    </span>
  );
}
