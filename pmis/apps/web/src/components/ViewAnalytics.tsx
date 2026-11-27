import * as Popover from '@radix-ui/react-popover';
import { BarChart3 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RegisterDefinition, RegisterRecord } from '@/api/types';
import { fieldLabel, showValue } from '@/components/RegisterFields';
import { Tip } from '@/components/Tip';
import { breakdown, numberStats } from '@/lib/viewAnalytics';

const STATE = 'state';

/**
 * Free analytics on any view: a button in the toolbar that opens a small panel counting the rows the view shows by state or by any list or
 * yes/no field, and totalling any number field. It reads the records the screen has already loaded (the same for the list, the wide table, the
 * board and the map), so it adds no request and shows nothing the caller cannot already see. When the view has more rows than are loaded
 * the panel says how many it counted.
 */
export function ViewAnalytics({ def, records, total }: { def: RegisterDefinition; records: RegisterRecord[]; total: number | undefined }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const groupable = useMemo(() => def.fields.filter((f) => f.type === 'list' || f.type === 'yes_no'), [def]);
  const numeric = useMemo(() => def.fields.filter((f) => f.type === 'number'), [def]);
  const [by, setBy] = useState(STATE);
  const [num, setNum] = useState('');
  const gf = groupable.find((f) => f.code === by);
  const slices = useMemo(() => breakdown(records, (r) => (gf ? (r.data[gf.code] === undefined || r.data[gf.code] === null || r.data[gf.code] === '' ? '' : showValue(gf, r.data[gf.code], lang, t)) : t(`regState.${r.state}`)), t('analytics.none'), t('analytics.other')), [records, gf, lang, t]);
  const nf = numeric.find((f) => f.code === num) ?? numeric[0];
  const stats = useMemo(() => (nf ? numberStats(records, (r) => r.data[nf.code]) : null), [records, nf]);
  const fmt = (n: number) => n.toLocaleString(lang === 'ar' ? 'ar-LY-u-nu-latn' : 'en-US', { maximumFractionDigits: 2 });
  const partial = total !== undefined && total > records.length;
  return (
    <Popover.Root>
      <Tip text={t('analytics.title')}>
        <Popover.Trigger asChild>
          <button type="button" className="btn" data-testid="view-analytics" aria-label={t('analytics.title')}><BarChart3 size={16} /></button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="card z-50 w-80 space-y-3 p-3 text-sm shadow-lg" data-testid="view-analytics-panel">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold">{t('analytics.title')}</div>
            <span className="text-xs text-mute tnum" data-testid="analytics-counted">{t('analytics.counted', { n: records.length })}</span>
          </div>
          {partial && <p className="text-xs text-waitInk" data-testid="analytics-partial">{t('analytics.partial', { n: records.length, total })}</p>}
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-mute">{t('analytics.group_by')}</span>
            <select className="input w-full" value={by} onChange={(e) => setBy(e.target.value)} data-testid="analytics-by">
              <option value={STATE}>{t('analytics.by_state')}</option>
              {groupable.map((f) => <option key={f.code} value={f.code}>{fieldLabel(f, lang)}</option>)}
            </select>
          </label>
          {slices.length === 0 ? <p className="text-mute" data-testid="analytics-empty">{t('analytics.empty')}</p> : (
            <ul className="space-y-1.5" data-testid="analytics-slices">
              {slices.map((s) => (
                <li key={s.key} data-testid={`analytics-slice-${s.key}`}>
                  <div className="flex items-baseline justify-between gap-2"><span className="truncate">{s.label}</span><span className="tnum shrink-0" dir="ltr">{s.count} · {Math.round(s.share * 100)}%</span></div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-line" role="presentation"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, Math.round(s.share * 100))}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
          {nf && (
            <div className="space-y-1.5 border-t border-line pt-2" data-testid="analytics-numbers">
              <label className="block space-y-1">
                <span className="text-xs font-semibold text-mute">{t('analytics.number_field')}</span>
                <select className="input w-full" value={nf.code} onChange={(e) => setNum(e.target.value)} data-testid="analytics-num">
                  {numeric.map((f) => <option key={f.code} value={f.code}>{fieldLabel(f, lang)}</option>)}
                </select>
              </label>
              {stats ? (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 tnum" data-testid="analytics-stats">
                  {(['sum', 'avg', 'min', 'max'] as const).map((k) => (<div key={k} className="flex justify-between gap-2"><dt className="text-mute">{t(`analytics.${k}`)}</dt><dd dir="ltr">{fmt(stats[k])}</dd></div>))}
                </dl>
              ) : <p className="text-mute">{t('analytics.no_numbers')}</p>}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
