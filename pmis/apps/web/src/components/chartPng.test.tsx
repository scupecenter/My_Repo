import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { chartFileName, chartToPng } from '@/lib/chartPng';
import { setExtra } from '@/lib/uiExtras';
import { EChart } from './EChart';

/** Item 14: download any chart as PNG. */
afterEach(() => { act(() => setExtra('chart_png', true)); });

describe('chart PNG', () => {
  it('names the file after the chart label and the day, in any language', () => {
    const d = new Date('2026-11-28T10:00:00Z');
    expect(chartFileName('Sites by status', d)).toBe('Sites-by-status-2026-11-28.png');
    expect(chartFileName('المواقع حسب الحالة', d)).toBe('المواقع-حسب-الحالة-2026-11-28.png');
    expect(chartFileName('  ', d)).toBe('chart-2026-11-28.png');
  });

  it('gives null, not an error, when the browser cannot draw (no canvas) or the host has no chart yet', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    expect(await chartToPng(host, '#fff')).toBeNull();
    host.remove();
  });

  it('every chart has a download button with a name, and a person can switch it off', async () => {
    const u = userEvent.setup();
    render(<EChart build={() => ({})} label="Demo chart" testid="demo" />);
    const b = screen.getByTestId('demo-png');
    expect(b).toHaveAccessibleName(/PNG|png/);
    await u.click(b); // no canvas in jsdom: it must not throw
    act(() => setExtra('chart_png', false));
    expect(screen.queryByTestId('demo-png')).toBeNull();
    expect(screen.getByTestId('demo')).toHaveAttribute('role', 'img');
  });
});
