import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRegisterRules } from '@/mocks/handlers.registerRules';
import { renderApp, signIn } from '@/test/utils';
import { LinkFills } from './LinkFills';

beforeEach(() => resetRegisterRules());

describe('link fill rules (0772)', () => {
  it('starts empty, adds a rule with a reason, and offers only target fields of the same type', async () => {
    await signIn('pm');
    renderApp(<LinkFills />);
    expect(await screen.findByTestId('lf-empty')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId('lf-new-link'), 'invoices/procurement_record_id');
    await userEvent.selectOptions(screen.getByTestId('lf-new-source'), 'due_date');
    const target = screen.getByTestId('lf-new-target');
    expect(within(target).queryByText('Last Invoice No')).toBeNull();
    await userEvent.selectOptions(target, 'delivery_date');
    await userEvent.click(screen.getByTestId('lf-new-add'));
    expect(screen.getByTestId('lf-row-invoices-procurement_record_id-delivery_date')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('lf-save'));
    const dlg = await screen.findByTestId('lf-dialog');
    await userEvent.type(within(dlg).getByRole('textbox'), 'Invoice due date fills the order');
    await userEvent.click(within(dlg).getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i }));
    await waitFor(() => expect(screen.queryByTestId('lf-dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('lf-version').textContent).toMatch(/1/));
  });

  it('hides a rule instead of deleting it', async () => {
    await signIn('pm');
    renderApp(<LinkFills />);
    await userEvent.selectOptions(await screen.findByTestId('lf-new-link'), 'invoices/procurement_record_id');
    await userEvent.selectOptions(screen.getByTestId('lf-new-source'), 'invoice_no');
    await userEvent.selectOptions(screen.getByTestId('lf-new-target'), 'last_invoice_no');
    await userEvent.click(screen.getByTestId('lf-new-add'));
    await userEvent.click(screen.getByTestId('lf-active-invoices-procurement_record_id-last_invoice_no'));
    expect(screen.getByTestId('lf-row-invoices-procurement_record_id-last_invoice_no')).toBeInTheDocument();
  });
});
