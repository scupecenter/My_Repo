import { useEffect, useRef, useState } from 'react';
import type { ChartHandle } from '@/lib/echarts';

/** Colours of the active theme, read from the design tokens so a theme or brand change needs no chart code. */
export interface Palette { ink: string; mute: string; line: string; card: string; done: string; open: string; wait: string; late: string; lock: string; accent: string; pipe: string }

export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const g = (n: string, d: string) => cs.getPropertyValue(`--${n}`).trim() || d;
  return {
    ink: g('ink', '#1f2937'), mute: g('mute', '#6b7280'), line: g('line', '#e5e7eb'), card: g('card', '#ffffff'), done: g('done', '#16a34a'), open: g('open', '#2563eb'),
    wait: g('wait', '#d97706'), late: g('late', '#dc2626'), lock: g('lock', '#9ca3af'), accent: g('accent', '#0f766e'), pipe: g('pipe', '#e5e7eb'),
  };
}

/** Changes when the theme, the direction or the language changes, so charts redraw with the right colours and side. */
function useEnvKey(): string {
  const read = () => `${document.documentElement.getAttribute('data-theme') ?? 'light'}|${document.documentElement.dir}|${document.documentElement.lang}`;
  const [k, setK] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setK(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'dir', 'lang'] });
    return () => mo.disconnect();
  }, []);
  return k;
}

/**
 * An ECharts chart (loaded on demand). `build` makes the option from the palette; it should be memoised on the data. The chart is decorative for
 * assistive technology: `label` is its text alternative, and every number it shows is also on the page as text.
 */
export function EChart({ build, height = 220, label, testid, renderer = 'svg', onClick }: {
  build: (p: Palette, rtl: boolean) => unknown; height?: number | string; label: string; testid?: string;
  /** canvas for the site map (many animated marks); svg elsewhere */
  renderer?: 'svg' | 'canvas';
  /** a click on a mark: ECharts' event parameters (the site map opens the site card from `data`) */
  onClick?: (params: { data?: unknown; seriesId?: string }) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ChartHandle | null>(null);
  const latest = useRef(build);
  const click = useRef(onClick);
  useEffect(() => { click.current = onClick; });
  const env = useEnvKey();
  useEffect(() => { latest.current = build; });

  useEffect(() => {
    let dead = false;
    let ro: ResizeObserver | undefined;
    // Wait for the fonts, so text is measured with Cairo and not with the fallback (legends and labels would overlap in Arabic otherwise).
    const fonts = typeof document !== 'undefined' && document.fonts?.ready ? document.fonts.ready.catch(() => undefined) : Promise.resolve();
    void Promise.all([import('@/lib/echarts'), fonts]).then(([{ init }]) => {
      if (dead || !el.current) return;
      const c = init(el.current, renderer);
      c.on('click', (p) => click.current?.(p as { data?: unknown; seriesId?: string }));
      chart.current = c;
      c.setOption(latest.current(readPalette(), document.documentElement.dir === 'rtl'), true);
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => c.resize());
        ro.observe(el.current);
      }
    }).catch(() => undefined);
    return () => { dead = true; ro?.disconnect(); chart.current?.dispose(); chart.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the renderer is fixed for the life of the chart
  }, []);

  useEffect(() => {
    chart.current?.setOption(build(readPalette(), document.documentElement.dir === 'rtl'), true);
  }, [build, env]);

  return <div ref={el} role="img" aria-label={label} data-testid={testid} style={{ height, width: '100%', direction: 'ltr' }} />;
}
