import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRegisterRules } from '@/mocks/handlers.registerRules';
import { renderApp, signIn } from '@/test/utils';
import { RegisterRulesPanel } from './RegisterRulesPanel';

const page = () => renderApp(<Routes><Route path="/x" element={<RegisterRulesPanel />} /></Routes>, { route: '/x' });
beforeEach(() => resetRegisterRules());

describe('register rules panel (0390)', () => {
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
});
