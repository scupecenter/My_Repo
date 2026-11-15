import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/utils';
import { CommandPalette, siteIdTokens } from './CommandPalette';

const NAV = [{ key: 'sites', to: '/sites' }, { key: 'messages', to: '/messages' }];

function renderPalette() {
  return renderApp(<CommandPalette open onOpenChange={() => {}} items={NAV} />);
}

describe('siteIdTokens', () => {
  it('reads a list of Site IDs and leaves ordinary text alone', () => {
    expect(siteIdTokens('TR-101\nBN-205, tr-101 ZW-9')).toEqual(['TR-101', 'BN-205', 'ZW-9']);
    expect(siteIdTokens('Tripoli site')).toBeNull();
    expect(siteIdTokens('TR-101')).toBeNull();
  });
});

describe('CommandPalette (global search)', () => {
  it('lists the matching records by group, with the matched text highlighted', async () => {
    renderPalette();
    await userEvent.type(screen.getByTestId('palette-input'), 'tr-101');
    await waitFor(() => expect(screen.getByTestId('palette-section-sites')).toBeInTheDocument(), { timeout: 3000 });
    const hit = document.querySelector('[data-testid^="palette-hit-sites-"]') as HTMLElement;
    expect(hit).not.toBeNull();
    expect(hit.querySelector('mark')?.textContent).toBe('TR-101');
  });

  it('turns a pasted list of Site IDs into one Site ID in list action and reports the IDs not found', async () => {
    renderPalette();
    await userEvent.type(screen.getByTestId('palette-input'), 'TR-101 BN-205 ZZ-999');
    await waitFor(() => expect(screen.getByTestId('palette-site-list')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByTestId('palette-not-found').textContent).toContain('ZZ-999');
    expect(screen.queryByTestId('palette-section-sites')).toBeNull();
  });

  it('moves the active option with the arrow keys', async () => {
    renderPalette();
    const input = screen.getByTestId('palette-input');
    await userEvent.type(input, 'tr-101');
    await waitFor(() => expect(screen.getByTestId('palette-section-sites')).toBeInTheDocument(), { timeout: 3000 });
    const first = input.getAttribute('aria-activedescendant');
    await userEvent.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).not.toBe(first);
  });
});
