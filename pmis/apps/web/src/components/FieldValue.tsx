import { useTranslation } from 'react-i18next';
import type { RegisterField } from '@/api/types';
import { showValue } from './RegisterFields';

/**
 * Cell display of a field value (item 15 of the 2026-11-27 research, Smartsheet coloured dropdowns and monday status/progress columns):
 * - a list value shows as a chip in the colour the admin set in Settings, Lists (a small dot keeps colour from being the only signal);
 * - a percentage shows as a number over a thin progress bar (one progressbar, the number in text);
 * - a date also reads relatively ("in 3 days"), red once it has passed, amber today, with the absolute date in the tooltip.
 * Everything else renders the text it always did. Display only: the stored value and every check stay the same.
 */
const DAY = 86_400_000;

/** A readable ink on the admin's colour: dark on a light colour, white on a dark one. */
function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'var(--ink)';
  const n = parseInt(m[1]!, 16);
  const lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.6 ? '#1f2937' : '#ffffff';
}

export function relDay(v: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d.getTime() - today.getTime()) / DAY);
}

export function FieldValue({ f, v, testid }: { f: RegisterField; v: unknown; testid?: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  if (v === undefined || v === null || v === '') return <>{showValue(f, v, lang, t)}</>;
  if (f.type === 'list' && typeof v === 'string') {
    const o = f.options?.find((x) => x.value === v);
    if (o?.colour) return (
      <span className="chip text-xs" style={{ background: o.colour, color: inkOn(o.colour) }} data-testid={testid} data-colour={o.colour}>
        {(lang === 'ar' && o.label_ar) || o.label_en}
      </span>
    );
  }
  if (f.type === 'multi_list' && Array.isArray(v)) {
    const opts = v.map((x) => f.options?.find((y) => y.value === x));
    if (opts.some((o) => o?.colour)) return (
      <span className="inline-flex flex-wrap items-center gap-1" data-testid={testid}>
        {v.map((x) => {
          const o = f.options?.find((y) => y.value === x);
          return o?.colour
            ? <span key={x} className="chip text-xs" style={{ background: o.colour, color: inkOn(o.colour) }} data-colour={o.colour}>{(lang === 'ar' && o.label_ar) || o.label_en}</span>
            : <span key={x}>{o ? ((lang === 'ar' && o.label_ar) || o.label_en) : String(x)}</span>;
        })}
      </span>
    );
  }
  if ((f.type as string) === 'percentage' && typeof v === 'number' && Number.isFinite(v)) {
    const pct = Math.max(0, Math.min(100, v));
    return (
      <span className="inline-flex min-w-24 items-center gap-2" data-testid={testid} data-percent={pct}>
        <span className="tabular-nums">{pct}%</span>
        <span role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('cells.progress')}
          className="h-1.5 w-16 overflow-hidden rounded-full bg-card2">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%`, insetInlineStart: 0 }} />
        </span>
      </span>
    );
  }
  if (f.type === 'date' && typeof v === 'string') {
    const d = relDay(v, new Date());
    if (d !== null && Math.abs(d) <= 60) {
      const rel = d === 0 ? t('rel.today') : d === 1 ? t('rel.tomorrow') : d === -1 ? t('rel.yesterday') : d > 0 ? t('rel.in_days', { count: d }) : t('rel.days_ago', { count: -d });
      const tone = d < 0 ? 'text-lateInk' : d === 0 ? 'text-waitInk' : 'text-mute';
      return <span className={`whitespace-nowrap ${tone}`} title={v} data-testid={testid} data-rel-days={d}>{rel}<span className="text-mute"> · {v}</span></span>;
    }
  }
  return <span data-testid={testid}>{showValue(f, v, lang, t)}</span>;
}
