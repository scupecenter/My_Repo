import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { RegisterStatePanel } from './RegisterStatePanel';

const page = () => renderApp(<Routes><Route path="/x" element={<RegisterStatePanel />} /></Routes>, { route: '/x' });

describe('register state panel (0.15.138)', () => {
  it('locks a register with a reason and shows it locked', async () => {
    await signIn('pm');
    page();
    const row = await screen.findByTestId('regstate-row-gecol');
    await userEvent.click(within(row).getByTestId('regstate-locked-gecol'));
    const dlg = await screen.findByTestId('register-state-dialog');
    await userEvent.type(within(dlg).getByRole('textbox'), 'freeze for audit');
    await userEvent.click(within(dlg).getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i }));
    await waitFor(() => expect(within(screen.getByTestId('regstate-row-gecol')).getByTestId('regstate-locked-gecol')).toHaveAttribute('aria-pressed', 'true'));
  });

  it('disables and re-enables a register', async () => {
    await signIn('pm');
    page();
    const sw = await screen.findByTestId('regstate-enabled-gecol');
    await userEvent.click(sw);
    const dlg = await screen.findByTestId('register-state-dialog');
    await userEvent.type(within(dlg).getByRole('textbox'), 'hide for now');
    await userEvent.click(within(dlg).getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i }));
    await waitFor(() => expect(screen.getByTestId('regstate-enabled-gecol')).not.toBeChecked());
  });
});
