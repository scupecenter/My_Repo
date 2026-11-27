import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRegisterLinks } from '@/mocks/handlers.registerLinks';
import { renderApp, signIn } from '@/test/utils';
import { RegisterLinksPanel } from './RegisterLinksPanel';
import { RegisterLinkSelect } from '@/components/RegisterLinkSelect';

const page = () => renderApp(<Routes><Route path="/x" element={<RegisterLinksPanel />} /></Routes>, { route: '/x' });
beforeEach(() => resetRegisterLinks());

describe('register link catalogue (0431)', () => {
  it('switches a link off with a reason, and nothing is removed', async () => {
    await signIn('pm');
    page();
    const sw = await screen.findByTestId('link-enabled-warehouse-procurement_order_id');
    expect(sw).toBeChecked();
    await userEvent.click(sw);
    const dlg = await screen.findByTestId('link-flag-dialog');
    await userEvent.type(within(dlg).getByRole('textbox'), 'pause this link');
    await userEvent.click(within(dlg).getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i }));
    await waitFor(() => expect(screen.getByTestId('link-enabled-warehouse-procurement_order_id')).not.toBeChecked());
    expect(screen.getByTestId('link-row-issues-risk_entity_id')).toBeInTheDocument();
  });

  it('is read only for a user who is not an admin', async () => {
    await signIn('engineer');
    page();
    expect(await screen.findByTestId('link-enabled-warehouse-procurement_order_id')).toBeDisabled();
    expect(screen.queryByTestId('links-add')).toBeNull();
  });

  it('draws the generic picker of a link field', async () => {
    await signIn('pm');
    renderApp(<RegisterLinkSelect registerKey="issues" field="risk_entity_id" siteId={null} value={null} onChange={() => undefined} editable />);
    expect(await screen.findByRole('option', { name: /risks sample/ })).toBeInTheDocument();
  });
});
