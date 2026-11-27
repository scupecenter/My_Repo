import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EChart, type Palette } from '@/components/EChart';
import type { MeasureSlice } from '@/lib/viewAnalytics';

const FONT = 'Cairo, system-ui, sans-serif';

export type ChartKind = 'bar' | 'pie';

/**
 * The shared chart of a view mode (decision V4): a screen hands it ready slices (label + value) and it draws them as bars or a ring, with the
 * same numbers as text below for assistive technology and for copying. Nothing fetches: the caller computes the slices from rows it already
 * loaded. The chart itself stays LTR; the labels and the text list follow the language.
 */
export function ChartView({ testid, slices, kind, label, head, fmt }: {
  testid: string;
  slices: MeasureSlice[];
  kind: ChartKind;
  /** the chart's text alternative: what the axes show */
  label: string;
  /** an optional line above the chart (the screen's own status, e.g. a partial-data note) */
  head?: ReactNode;
  fmt?: (n: number) => string;
}) {
  const { t, i18n } = useTranslation();
  const f = fmt ?? ((n: number) => n.toLocaleString(i18n.language === 'ar' ? 'ar-LY-u-nu-latn' : 'en-US', { maximumFractionDigits: 2 }));
  const build = useMemo(() => (p: Palette, rtl: boolean) => kind === 'pie' ? ({
    textStyle: { fontFamily: FONT },
    aria: { enabled: true },
    tooltip: { trigger: 'item' },
    series: [{
      type: 'pie',
      radius: ['38%', '68%'],
      label: { color: p.ink, fontFamily: FONT },
      itemStyle: { borderColor: p.card, borderWidth: 1 },
      data: slices.map((s, i) => ({ name: s.label, value: Math.round(s.value * 100) / 100, itemStyle: { color: [p.accent, p.open, p.wait, p.done, p.late, p.lock, p.mute, p.pipe, p.line][i % 9] } })),
    }],
  }) : ({
    textStyle: { fontFamily: FONT },
    aria: { enabled: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 16, right: 16, top: 16, bottom: 8, containLabel: true },
    xAxis: { type: 'category', inverse: rtl, data: slices.map((s) => s.label), axisLabel: { color: p.mute, interval: 0, rotate: slices.length > 5 ? 24 : 0 } },
    yAxis: { type: 'value', axisLabel: { color: p.mute }, splitLine: { lineStyle: { color: p.line } } },
    series: [{ type: 'bar', itemStyle: { color: p.accent }, emphasis: { focus: 'series' }, data: slices.map((s) => Math.round(s.value * 100) / 100) }],
  }), [slices, kind]);
  return (
    <div data-testid={testid}>
      {head}
      {slices.length === 0 ? <p className="p-3 text-sm text-mute" data-testid={`${testid}-empty`}>{t('chartv.empty')}</p> : (
        <>
          <EChart build={build} height={260} label={label} testid={`${testid}-chart`} />
          <ul className="mt-2 space-y-1 px-3 pb-3 text-sm" data-testid={`${testid}-slices`}>
            {slices.map((s) => (
              <li key={s.key} className="flex items-baseline justify-between gap-2" data-testid={`${testid}-slice-${s.key}`}>
                <span className="truncate">{s.label}</span><span className="tnum shrink-0" dir="ltr">{f(s.value)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
