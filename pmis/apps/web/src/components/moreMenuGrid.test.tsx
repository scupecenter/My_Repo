import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { MoreMenu } from '@/components/PageHeader';
import { renderApp, signIn } from '@/test/utils';

const items = (pick: () => void) => [
  { id: 'a', label: 'Export to Excel', testid: 'it-export', onSelect: pick },
  { id: 'b', label: 'Copy summary', testid: 'it-copy', onSelect: () => undefined },
  { id: 'c', label: 'Print list', testid: 'it-print', onSelect: () => undefined },
];

/** Item 10: the More menu as a list (default) or an icon grid with search, a personal appearance choice (more_menu). */
describe('More menu: list or icon grid with search', () => {
  it('is a list by default', async () => {
    await signIn('pm');
    renderApp(<MoreMenu items={items(() => undefined)} />);
    await userEvent.setup().click(await screen.findByTestId('more-menu'));
    expect(await screen.findByTestId('more-panel')).toHaveAttribute('data-mode', 'list');
    expect(screen.queryByTestId('more-search')).toBeNull();
  });

  it('grid mode: icon tiles, search filters them, an empty result says so, a pick runs and closes', async () => {
    await signIn('pm');
    const pick = vi.fn();
    const prof = await api.get<{ version: number }>('/me/profile');
    await api.patch('/me/profile', { body: { ui_prefs: { more_menu: 'grid' } }, version: prof.version });
    renderApp(<MoreMenu items={items(pick)} />);
    const u = userEvent.setup();
    await waitFor(async () => { await u.click(await screen.findByTestId('more-menu')); expect(await screen.findByTestId('more-panel')).toHaveAttribute('data-mode', 'grid'); });
    const panel = screen.getByTestId('more-panel');
    expect(within(panel).getAllByRole('menuitem')).toHaveLength(3);
    await u.type(within(panel).getByTestId('more-search'), 'print');
    expect(within(panel).getAllByRole('menuitem')).toHaveLength(1);
    await u.clear(within(panel).getByTestId('more-search'));
    await u.type(within(panel).getByTestId('more-search'), 'zzz');
    expect(within(panel).queryAllByRole('menuitem')).toHaveLength(0);
    expect(within(panel).getByTestId('more-none')).toBeInTheDocument();
    await u.clear(within(panel).getByTestId('more-search'));
    await u.click(within(panel).getByTestId('it-export'));
    expect(pick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('more-panel')).toBeNull());
  });
});
