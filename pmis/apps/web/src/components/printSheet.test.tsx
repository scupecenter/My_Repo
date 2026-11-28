import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrintButton, PrintSheet } from './PrintSheet';
import { renderApp, signIn } from '@/test/utils';

describe('PrintSheet', () => {
  it('shows title, filters and footer in the print header, and the button opens the print dialog', async () => {
    await signIn('pm');
    const spy = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    renderApp(<PrintSheet title="Contractor ranking" filters={['Trade: Tower', 'Period: 2026-11']}><PrintButton /><p>body</p></PrintSheet>);
    expect(await screen.findByTestId('print-sheet-head')).toHaveTextContent('Contractor ranking');
    expect(screen.getByTestId('print-sheet-filters')).toHaveTextContent('Trade: Tower | Period: 2026-11');
    expect(screen.getByTestId('print-sheet-foot')).toHaveTextContent('Contractor ranking');
    expect(screen.getByTestId('print-sheet')).toHaveAttribute('data-orientation', 'portrait');
    await userEvent.click(screen.getByTestId('print-button'));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
  it('has no filter line when no filter is used', async () => {
    await signIn('pm');
    renderApp(<PrintSheet title="T" orientation="landscape"><p>x</p></PrintSheet>);
    expect(await screen.findByTestId('print-sheet')).toHaveAttribute('data-orientation', 'landscape');
    expect(screen.queryByTestId('print-sheet-filters')).toBeNull();
  });
});
