import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { resetRegisterRules } from '@/mocks/handlers.registerRules';
import { renderApp, signIn } from '@/test/utils';
import { RegisterRulesPanel } from './RegisterRulesPanel';

const page = () => renderApp(<Routes><Route path="/x" element={<RegisterRulesPanel />} /></Routes>, { route: '/x' });
beforeEach(() => resetRegisterRules());

describe('register rules panel (0430)', () => {
  it('switches a rule with a reason', async () => {
    await signIn('pm');
    page();
    const sw = await screen.findByTestId('regrule-invoices-order_required');
    expect(sw).not.toBeChecked();
    await userEvent.click(sw);
    const dlg = await screen.findByTestId('register-rules-dialog');
    await userEvent.type(within(dlg).getByRole('textbox'), 'invoices need an order');
    await userEvent.click(within(dlg).getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i }));
    await waitFor(() => expect(screen.getByTestId('regrule-invoices-order_required')).toBeChecked());
  });

  it('lists the keys of other registers: the editable ones of Financial Advances, and the system keys of Procurement read only (EN and AR)', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('regrule-financial_advances-master_export')).not.toBeChecked();
    expect(screen.getByTestId('regrule-financial_advances-currency')).toHaveValue('LYD');
    const other = screen.getByTestId('regrules-other-procurement');
    expect(other).toHaveTextContent('scope_rows');
    expect(other).toHaveTextContent(en.regrules.other_note);
    expect(screen.queryByTestId('regrules-other-invoices')).not.toBeInTheDocument();
    for (const k of ['other_title_one', 'other_title_other', 'other_note']) expect((ar.regrules as Record<string, string>)[k]).toBeTruthy();
  });
});
