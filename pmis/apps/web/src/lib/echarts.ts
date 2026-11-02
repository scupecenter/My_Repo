import { BarChart, GaugeChart, PieChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

// Only what the dashboard draws: bars, a status ring and the health gauge, on SVG (crisp at any size, no canvas needed). Loaded on demand by EChart.
echarts.use([BarChart, PieChart, GaugeChart, GridComponent, TooltipComponent, LegendComponent, AriaComponent, SVGRenderer]);

export interface ChartHandle {
  setOption(option: unknown, notMerge?: boolean): void;
  resize(): void;
  dispose(): void;
}

export const init = (el: HTMLElement): ChartHandle => echarts.init(el, undefined, { renderer: 'svg' }) as unknown as ChartHandle;
