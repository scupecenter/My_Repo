import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { CustomRegistersHub } from './CustomRegistersHub';
import { isCustomKey } from '@/lib/registerForms';

/** The hub of the custom registers (migration 0592): it lists only custom register keys; with none enabled it says so. */
describe('Custom registers hub', () => {
  it('says so when no custom register is available', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/custom-registers" element={<CustomRegistersHub />} /></Routes>, { route: '/custom-registers' });
    expect(await screen.findByTestId('custreg-hub-empty')).toBeInTheDocument();
  });
  it('recognises custom keys only', () => {
    expect(isCustomKey('custom_tower_audit')).toBe(true);
    expect(isCustomKey('procurement')).toBe(false);
    expect(isCustomKey('custom_')).toBe(false);
    expect(isCustomKey('registers.custom')).toBe(false);
  });
});
