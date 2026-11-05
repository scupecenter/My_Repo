import { BarChart, EffectScatterChart, GaugeChart, PieChart, ScatterChart } from 'echarts/charts';
import { AriaComponent, GeoComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';
import { LIBYA_GEOJSON } from './libya';

// Only what the dashboard draws: bars, a status ring and the health gauge, on SVG (crisp at any size); and the site map (OV-12): the bundled outline of
// Libya as a geo component with scatter and effect-scatter series, on canvas (a thousand towers with pulsing lights stay smooth). Loaded on demand by EChart.
// Nothing here fetches anything: the outline is part of the bundle (no map tiles, technical decision "site map" 2026-11-05).
echarts.use([BarChart, PieChart, GaugeChart, ScatterChart, EffectScatterChart, GridComponent, GeoComponent, TooltipComponent, LegendComponent, AriaComponent, SVGRenderer, CanvasRenderer]);
echarts.registerMap('libya', LIBYA_GEOJSON as unknown as Parameters<typeof echarts.registerMap>[1]);

export interface ChartHandle {
  setOption(option: unknown, notMerge?: boolean): void;
  resize(): void;
  dispose(): void;
  on(event: string, handler: (params: unknown) => void): void;
}

export const init = (el: HTMLElement, renderer: 'svg' | 'canvas' = 'svg'): ChartHandle => echarts.init(el, undefined, { renderer }) as unknown as ChartHandle;
