import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SiteGantt } from './SiteGantt';

const node = (code: string, planned?: string, actual?: string) => ({ code, kind: 'milestone', name_en: code, state: 'planned', planned_date: planned, actual_date: actual });

describe('SiteGantt', () => {
  it('draws the dependency lines, flags an order conflict and shows the today line', () => {
    const site = { pipeline: [node('A', undefined, '2026-02-10'), node('B', '2026-03-01'), node('C', '2026-02-20')] } as never;
    render(<SiteGantt site={site} today="2026-02-25" />);
    expect(screen.getByTestId('gantt-dep-B').getAttribute('data-conflict')).toBe('false');
    expect(screen.getByTestId('gantt-dep-C').getAttribute('data-conflict')).toBe('true');
    expect(screen.queryByTestId('gantt-dep-A')).toBeNull();
    expect(screen.getByTestId('gantt-conflicts')).toBeTruthy();
    expect(screen.getByTestId('gantt-today')).toBeTruthy();
  });
  it('renders nothing without dates', () => {
    const { container } = render(<SiteGantt site={{ pipeline: [node('A')] } as never} />);
    expect(container.innerHTML).toBe('');
  });
  it('marks the open stages as the critical path and says which one added the most delay', () => {
    const site = { pipeline: [{ ...node('A', undefined, '2026-02-10'), baseline_date: '2026-02-01' }, { ...node('B', '2026-03-20'), baseline_date: '2026-03-01' }, { ...node('C', '2026-04-01'), baseline_date: '2026-03-25' }] } as never;
    render(<SiteGantt site={site} today="2026-02-25" />);
    expect(screen.getByTestId('gantt-row-A').getAttribute('data-critical')).toBe('false');
    expect(screen.getByTestId('gantt-row-B').getAttribute('data-critical')).toBe('true');
    expect(screen.getByTestId('gantt-row-C').getAttribute('data-critical')).toBe('true');
    expect(screen.getByTestId('gantt-critical-summary')).toBeTruthy();
  });
});
