import { screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

const at = (register: string) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: `/admin/settings/registers/columns?register=${register}`, locale: 'en' });

describe('Settings > Registers > Columns lists the Site Master streams', () => {
  it('has the six streams before the registers and opens the columns of a stream', async () => {
    await signIn('pm');
    at('stream:cw');
    const pick = await screen.findByTestId('regcols-register');
    const groups = Array.from(pick.querySelectorAll('optgroup')).map((g) => g.getAttribute('label'));
    expect(groups[0]).toBe('Site Master streams');
    expect(within(pick).getAllByRole('option').slice(0, 6).map((o) => o.textContent)).toEqual(['Design & Acquisition', 'SOW', 'CW', 'TE', 'HOTO', 'O&M']);
    expect(await screen.findByTestId('stream-columns-cw')).toBeInTheDocument();
    expect(screen.getByTestId('stream-columns-add')).toHaveAttribute('href', '/admin/settings/workflow/editor');
  });

  it('keeps the register view for a register key', async () => {
    await signIn('pm');
    at('gecol');
    expect(await screen.findByTestId('regcols-table')).toBeInTheDocument();
    expect(screen.queryByTestId('stream-columns-cw')).toBeNull();
  });
});
