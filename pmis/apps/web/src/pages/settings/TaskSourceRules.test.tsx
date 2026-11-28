import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRegisterRules } from '@/mocks/handlers.registerRules';
import { renderApp, signIn } from '@/test/utils';
import { TaskSourceRules } from './TaskSourceRules';

beforeEach(() => resetRegisterRules());

describe('task source rules (0770)', () => {
  it('shows the seeded rules and adds a rule for a status, with a reason', async () => {
    await signIn('pm');
    renderApp(<TaskSourceRules />);
    expect(await screen.findByTestId('tsr-row-procurement-B2')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId('tsr-new-register'), 'procurement');
    await userEvent.selectOptions(screen.getByTestId('tsr-new-task'), 'B3');
    await userEvent.selectOptions(screen.getByTestId('tsr-new-date'), 'po_wo_date');
    await userEvent.selectOptions(screen.getByTestId('tsr-new-cond'), 'order_status');
    await userEvent.click(within(screen.getByTestId('tsr-new-values')).getByLabelText('Delivered'));
    await userEvent.click(screen.getByTestId('tsr-new-add'));
    expect(screen.getByTestId('tsr-row-procurement-B3').textContent).toMatch(/Delivered/);
    await userEvent.click(screen.getByTestId('tsr-save'));
    const dlg = await screen.findByTestId('tsr-dialog');
    await userEvent.type(within(dlg).getByRole('textbox'), 'Delivered orders close the access task');
    await userEvent.click(within(dlg).getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i }));
    await waitFor(() => expect(screen.queryByTestId('tsr-dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('tsr-version').textContent).toMatch(/3/));
  });

  it('hides a rule instead of deleting it, and is read only without the Settings right', async () => {
    await signIn('pm');
    renderApp(<TaskSourceRules />);
    await userEvent.click(await screen.findByTestId('tsr-active-procurement-B1'));
    expect(screen.getByTestId('tsr-row-procurement-B1')).toBeInTheDocument();
    expect(screen.getByTestId('tsr-save')).toBeEnabled();
  });
});
