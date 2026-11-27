import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/utils';
import { SiteCodeField } from './RegisterFields';

/** Item 12: a field that names sites by code keeps its stored text (codes joined by ", ") and is edited as chips. */
function Harness({ start, multi, na }: { start: string | null; multi?: boolean; na?: boolean }) {
  const [v, setV] = useState<string | null>(start);
  return <div><SiteCodeField id="f" value={v} onChange={setV} multi={multi} naOption={na} /><output data-testid="out">{v ?? 'null'}</output></div>;
}

describe('SiteCodeField', () => {
  it('shows each stored code as a chip and removing one keeps the others in the same text format', async () => {
    const u = userEvent.setup();
    renderApp(<Harness start="TRP-001, TRP-002" multi />);
    expect(await screen.findByTestId('f-chosen-TRP-001')).toBeTruthy();
    await u.click(screen.getByTestId('f-remove-TRP-001'));
    expect(screen.getByTestId('out').textContent).toBe('TRP-002');
    await u.click(screen.getByTestId('f-remove-TRP-002'));
    expect(screen.getByTestId('out').textContent).toBe('null');
  });
  it('a single-site field takes N/A where it is allowed and hides the search once it holds a value', async () => {
    const u = userEvent.setup();
    renderApp(<Harness start={null} na />);
    await u.click(await screen.findByTestId('f-na'));
    expect(screen.getByTestId('out').textContent).toBe('N/A');
    expect(screen.queryByTestId('f')).toBeNull();
  });
});
