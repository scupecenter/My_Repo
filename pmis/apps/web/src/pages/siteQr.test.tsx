import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { Site } from './Site';

/** QR code per site: the site page has an icon button (hover hint and aria-label) that opens a printable sheet with the site page address. */
const SITE = siteIdOf(2);
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
afterEach(() => cleanup());

describe('site QR sheet', () => {
  it('opens a sheet with the code, the names and the site address, and prints it', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    const btn = await screen.findByTestId('site-qr-open');
    expect(btn).toHaveAttribute('aria-label');
    await u.click(btn);
    const sheet = await screen.findByTestId('site-qr-sheet');
    expect(within(sheet).getByTestId('site-qr-code')).toHaveTextContent('WM103');
    expect(within(sheet).getByTestId('site-qr-url')).toHaveTextContent(`/sites/${SITE}`);
    expect(within(sheet).getByRole('img')).toHaveAttribute('aria-label');
    await u.click(screen.getByTestId('site-qr-print'));
    expect(print).toHaveBeenCalledTimes(1);
    await u.click(screen.getByTestId('site-qr-close'));
    expect(screen.queryByTestId('site-qr-dialog')).toBeNull();
    print.mockRestore();
  });
});
