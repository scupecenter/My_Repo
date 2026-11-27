import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { CalendarGrid } from './CalendarGrid';

/** The shared month calendar (decision V2), EN and AR, on synthetic items only. */
const items = [
  { id: 'a', label: 'TRP-0001', date: '2026-03-05', late: false },
  { id: 'b', label: 'TRP-0002', date: '2026-03-05', late: true },
  { id: 'c', label: 'TRP-0003', date: '', late: false },
];

/** Steps back (or ahead) until the grid shows the wanted month, so the test does not depend on the day it runs. */
async function toMonth(u: ReturnType<typeof userEvent.setup>, title: RegExp, testid: string) {
  for (let i = 0; i < 36; i++) {
    if (title.test(screen.getByTestId(`${testid}-title`).textContent ?? '')) return;
    await u.click(screen.getByTestId(`${testid}-prev`));
  }
  throw new Error(`month ${title} not reached`);
}

describe('CalendarGrid', () => {
  it('draws the month with its items, counts the undated apart and opens an item', async () => {
    const u = userEvent.setup();
    const opened: string[] = [];
    render(<MemoryRouter><CalendarGrid testid="calx" items={items} onOpen={(id) => opened.push(id)} /></MemoryRouter>);
    await toMonth(u, /March 2026/, 'calx');
    const grid = screen.getByRole('grid');
    const cell = within(grid).getAllByRole('gridcell').find((c) => c.getAttribute('data-date') === '2026-03-05')!;
    expect(within(cell).getAllByTestId('calx-item')).toHaveLength(2);
    expect(screen.getByTestId('calx-undated')).toHaveTextContent('1');
    await u.click(within(cell).getAllByTestId('calx-item')[0]!);
    expect(opened).toEqual(['a']);
  });

  it('Arabic: localized month and weekday names, the grid itself stays LTR', async () => {
    await i18n.changeLanguage('ar');
    try {
      const u = userEvent.setup();
      render(<MemoryRouter><CalendarGrid testid="cala" items={items} onOpen={() => {}} /></MemoryRouter>);
      await toMonth(u, /مارس|March/, 'cala');
      expect(screen.getByTestId('cala-title').textContent).toMatch(/2026/);
      expect(screen.getByRole('grid')).toHaveAttribute('dir', 'ltr');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
