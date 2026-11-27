import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

/** Decision 36 item 5: collapsible dashboard sections, remembered per user, with collapse all and expand all. */
describe('Dashboard collapsible sections', () => {
  beforeEach(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('dash.collapsed')) localStorage.removeItem(k); });
  it('a section collapses and opens, and the state is remembered', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/dashboard' });
    const toggle = await screen.findByTestId('dash-block-toggle-site_map', {}, { timeout: 8000 });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('dash-block-site_map').querySelector('[data-blk]')?.className).toContain('hidden');
    await waitFor(() => expect(Object.entries(localStorage).some(([k, v]) => k.startsWith('dash.collapsed.') && v.includes('site_map'))).toBe(true));
    fireEvent.click(screen.getByTestId('dash-expand-all'));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
  it('collapse all folds every section', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/dashboard' });
    await screen.findByTestId('dash-block-toggle-site_map', {}, { timeout: 8000 });
    fireEvent.click(screen.getByTestId('dash-collapse-all'));
    const toggles = screen.getAllByTestId(/^dash-block-toggle-/);
    expect(toggles.length).toBeGreaterThan(0);
    for (const t of toggles) expect(t).toHaveAttribute('aria-expanded', 'false');
  });
});
