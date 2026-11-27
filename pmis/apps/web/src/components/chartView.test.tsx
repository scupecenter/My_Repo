import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartView } from '@/components/ChartView';

vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

/** The shared chart of a view mode (decision V4): the numbers are always text as well, and an empty view says so instead of drawing nothing. */
describe('ChartView', () => {
  it('draws the slices and repeats every number as text', () => {
    render(<ChartView testid="cv" kind="bar" label="Chart of Number of rows by Approval state"
      slices={[{ key: 's0', label: 'Approved', value: 7 }, { key: 's1', label: 'Entry', value: 3 }]} />);
    expect(screen.getByRole('img', { name: 'Chart of Number of rows by Approval state' })).toBeInTheDocument();
    expect(screen.getByTestId('cv-slice-s0')).toHaveTextContent('Approved');
    expect(screen.getByTestId('cv-slice-s0')).toHaveTextContent('7');
    expect(screen.getByTestId('cv-slice-s1')).toHaveTextContent('Entry');
  });
  it('says the view has no rows instead of an empty drawing', () => {
    render(<ChartView testid="cv" kind="pie" label="x" slices={[]} />);
    expect(screen.getByTestId('cv-empty')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
