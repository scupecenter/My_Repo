import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { DefaultViewsSection } from '@/components/DefaultViewsSection';
import { SavedViews } from '@/components/SavedViews';
import { renderApp, signIn } from '@/test/utils';

type F = { q: string };
const props = (onApply: (f: F) => void) => ({ screen: 'dv-test', value: { q: '' }, empty: { q: '' }, onApply });

/** A default saved view per screen: set with the star, opens by itself next time, listed and reset in My profile. */
describe('Default view per screen', () => {
  it('star sets the default, the screen opens on it, the profile section lists and resets it', async () => {
    await signIn('pm');
    const v = await api.post<{ id: string }>('/saved-views', { body: { screen_key: 'dv-test', name: 'Mine A', filters: { q: 'abc' } } });
    const first = vi.fn();
    const { unmount } = renderApp(<SavedViews<F> {...props(first)} />);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId(`views-tab-dv-test-${v.id}`));
    await u.click(await screen.findByTestId('views-default'));
    await waitFor(() => expect(screen.getByTestId('views-default')).toHaveAttribute('aria-pressed', 'true'));
    unmount();

    const second = vi.fn();
    renderApp(<SavedViews<F> {...props(second)} />);
    await waitFor(() => expect(second).toHaveBeenCalledWith({ q: 'abc' }));
  });

  it('profile section lists the default and resets it', async () => {
    await signIn('pm');
    const v = await api.post<{ id: string }>('/saved-views', { body: { screen_key: 'dv-test2', name: 'Mine B', filters: {} } });
    await api.post(`/saved-views/${v.id}/set-default`, { body: {} });
    renderApp(<DefaultViewsSection />);
    expect(await screen.findByTestId('dv-row-dv-test2')).toHaveTextContent('Mine B');
    await userEvent.setup().click(screen.getByTestId('dv-reset-dv-test2'));
    await waitFor(() => expect(screen.queryByTestId('dv-row-dv-test2')).toBeNull());
  });
});
