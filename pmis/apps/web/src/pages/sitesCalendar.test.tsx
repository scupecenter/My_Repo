import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { Sites } from './Sites';

/** Decision V2: the Site list on a month calendar over a Master date column chosen in the Layout panel. Synthetic master rows only (TE Access Date 78). */
const Where = () => { const l = useLocation(); return <output data-testid="where">{l.search}</output>; };
const where = () => screen.getByTestId('where').textContent ?? '';
const T = 20_000;

async function toMonth(u: ReturnType<typeof userEvent.setup>, title: RegExp) {
  for (let i = 0; i < 36; i++) {
    if (title.test(screen.getByTestId('sites-calendar-title').textContent ?? '')) return;
    await u.click(screen.getByTestId('sites-calendar-prev'));
  }
  throw new Error(`month ${title} not reached`);
}

describe('V2 sites calendar', () => {
  it('Calendar in the Layout panel, the sites on the chosen Master date column, the field kept in the URL', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<><Sites /><Where /></>, { route: '/sites' });
    await screen.findByTestId('site-row-TR101');
    await u.click(screen.getByTestId('sites-view'));
    await u.click(await screen.findByTestId('sites-layout-calendar'));
    expect(where()).toContain('layout=calendar');
    await screen.findByTestId('sites-calendar');
    // the date column is chosen in the panel options; TE Access Date (78) is the one with values in the synthetic rows
    await u.click(screen.getByTestId('sites-view'));
    await u.selectOptions(await screen.findByTestId('sites-calendar-field'), '78');
    expect(where()).toContain('calf=78');
    expect(where()).toContain('layout=calendar');
    await toMonth(u, /March 2026/);
    const grid = screen.getByRole('grid');
    const cell = within(grid).getAllByRole('gridcell').find((c) => c.getAttribute('data-date') === '2026-03-10')!;
    expect(within(cell).getAllByTestId('sites-calendar-item')).toHaveLength(3);
    expect(within(cell).getAllByTestId('sites-calendar-item')[0]).toHaveTextContent('S360-001');
  }, T);
});
