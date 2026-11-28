import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetCompanies } from '@/mocks/handlers.companies';
import { renderApp, signIn } from '@/test/utils';
import { CompanyRecords } from './CompanyRecords';
import { CompanyDocumentTypes } from './settings/CompanyDocumentTypes';

const ID = '11111111-1111-4111-8111-111111111111';
const page = () => renderApp(<Routes><Route path="/companies/:id" element={<CompanyRecords />} /></Routes>, { route: `/companies/${ID}` });
beforeEach(() => resetCompanies());

describe('company contacts and documents (0745)', () => {
  it('adds a contact, makes a second one primary, and hides one (never deletes)', async () => {
    await signIn('pm');
    page();
    await userEvent.type(await screen.findByTestId('cc-name'), 'Sara Ali');
    await userEvent.click(screen.getByTestId('cc-primary'));
    await userEvent.click(screen.getByTestId('cc-add'));
    const row = await screen.findByText('Sara Ali');
    expect(row).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('cc-name'), 'Omar Nasr');
    await userEvent.click(screen.getByTestId('cc-add'));
    const omar = (await screen.findByText('Omar Nasr')).closest('li') as HTMLElement;
    await userEvent.click(within(omar).getByText(/make primary|اجعلها أساسية/i));
    await waitFor(() => expect(within(screen.getByText('Omar Nasr').closest('li') as HTMLElement).getByText(/primary|أساسية/i)).toBeInTheDocument());
    await userEvent.click(within(omar).getByText(/hide|إخفاء/i));
    await waitFor(() => expect(within(screen.getByText('Omar Nasr').closest('li') as HTMLElement).getByText(/hidden|مخفية/i)).toBeInTheDocument());
  });

  it('an expired certificate shows a red status and the company chip', async () => {
    await signIn('pm');
    page();
    await userEvent.selectOptions(await screen.findByTestId('cd-type'), 'insurance');
    await userEvent.type(screen.getByTestId('cd-expiry'), '2020-01-01');
    await userEvent.click(screen.getByTestId('cd-add'));
    expect(await screen.findByTestId('company-compliance-chip')).toBeInTheDocument();
    expect((await screen.findAllByText(/expired|منتهية/i)).length).toBeGreaterThan(0);
  });

  it('refuses an expiry before the issue date', async () => {
    await signIn('pm');
    page();
    await userEvent.selectOptions(await screen.findByTestId('cd-type'), 'tax');
    await userEvent.type(screen.getByTestId('cd-issued'), '2026-05-01');
    await userEvent.type(screen.getByTestId('cd-expiry'), '2026-01-01');
    await userEvent.click(screen.getByTestId('cd-add'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('Settings, company documents', () => {
  it('sets a type required for a company type, with a reason, and hides a type', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/x" element={<CompanyDocumentTypes />} /></Routes>, { route: '/x' });
    await userEvent.click(await screen.findByTestId('cdt-req-iso-cw_contractor'));
    await userEvent.click(screen.getByTestId('cdt-active-trade_licence'));
    await userEvent.click(screen.getByTestId('cdt-save'));
    const dlg = await screen.findByTestId('cdt-dialog');
    await userEvent.type(within(dlg).getByRole('textbox'), 'ISO is required');
    await userEvent.click(within(dlg).getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i }));
    await waitFor(() => expect(screen.getByTestId('cdt-req-iso-cw_contractor')).toBeChecked());
    expect(screen.getByTestId('cdt-row-trade_licence')).toBeInTheDocument();
  });

  it('is read only for a user who is not an admin', async () => {
    await signIn('engineer');
    renderApp(<Routes><Route path="/x" element={<CompanyDocumentTypes />} /></Routes>, { route: '/x' });
    expect(await screen.findByTestId('cdt-lead-iso')).toBeDisabled();
  });
});
