import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

/** Conditional formatting rules: the Formatting section of the Layout panel, the cell and the row they colour, and their order. Synthetic mock data only. */
const App = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;
const T = 20_000;

describe('register conditional formatting', () => {
  it('Procurement: a cell rule and a row rule are added in the Layout panel, colour the list, can be reordered and removed', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await u.click(screen.getByTestId('register-view'));
    const panel = await screen.findByTestId('register-view-format');
    expect(within(panel).getByTestId('register-view-format-none')).toBeInTheDocument();
    // "is not empty" needs no value: the first listed column, the cell red
    await u.selectOptions(within(panel).getByTestId('register-view-format-op'), 'notempty');
    await u.click(within(panel).getByTestId('register-view-format-add'));
    expect(within(panel).getByTestId('register-view-format-rule-0')).toHaveTextContent(/not empty/i);
    await u.keyboard('{Escape}');
    const cells = document.querySelectorAll('[data-fmt="red"]');
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0]!.getAttribute('title')).toMatch(/Rule:/);
    // a row rule, in amber, listed second
    await u.click(screen.getByTestId('register-view'));
    const p2 = await screen.findByTestId('register-view-format');
    await u.click(within(p2).getByTestId('register-view-format-tone-amber'));
    await u.selectOptions(within(p2).getByTestId('register-view-format-scope'), 'row');
    await u.selectOptions(within(p2).getByTestId('register-view-format-op'), 'notempty');
    await u.click(within(p2).getByTestId('register-view-format-add'));
    expect(within(p2).getByTestId('register-view-format-rule-1')).toHaveTextContent(/whole row/i);
    await u.keyboard('{Escape}');
    expect(document.querySelectorAll('[data-fmt-row="amber"]').length).toBeGreaterThan(0);
    // the rules are kept with the person's column prefs
    expect(Object.values(localStorage).some((v) => String(v).includes('"rules"'))).toBe(true);
    // reorder and remove
    await u.click(screen.getByTestId('register-view'));
    const p3 = await screen.findByTestId('register-view-format');
    await u.click(within(p3).getByTestId('register-view-format-up-1'));
    expect(within(p3).getByTestId('register-view-format-rule-0')).toHaveTextContent(/whole row/i);
    await u.click(within(p3).getByTestId('register-view-format-del-0'));
    await u.click(within(p3).getByTestId('register-view-format-del-0'));
    expect(within(p3).getByTestId('register-view-format-none')).toBeInTheDocument();
    await u.keyboard('{Escape}');
    expect(document.querySelectorAll('[data-fmt],[data-fmt-row]')).toHaveLength(0);
  }, T);
});
