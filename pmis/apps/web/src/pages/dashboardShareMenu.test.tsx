import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { renderApp, signIn } from '@/test/utils';

// the charts are not under test here; a canvas chart in jsdom has no 2d context
vi.mock('@/components/EChart', () => ({ EChart: () => null }));

/** P2: the dashboard output buttons live in one Share / Export menu; the map card keeps the Site ID search and Late only. */
describe('Dashboard Share / Export menu', () => {
  it('holds TV mode, copy link, manual items, the format, print and export, closed until opened', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/dashboard' });
    const btn = await screen.findByTestId('dash-share', {}, { timeout: 8000 });
    const panel = screen.getByTestId('dash-share-panel');
    expect(panel.className).toContain('hidden');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    for (const id of ['dash-tv', 'dash-copy-link', 'dash-manual-link']) expect(panel).toContainElement(screen.getByTestId(id));
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(panel.className).not.toContain('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
  it('remembers the chosen export format per browser as the default', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/dashboard' });
    const sel = await screen.findByTestId('dash-export-format', {}, { timeout: 8000 });
    fireEvent.change(sel, { target: { value: 'csv' } });
    expect(localStorage.getItem('dash.exportFormat')).toBe('"csv"');
    localStorage.removeItem('dash.exportFormat');
  });
});
