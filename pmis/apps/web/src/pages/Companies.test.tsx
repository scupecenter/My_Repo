import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetCompanies } from '@/mocks/handlers.companies';
import { renderApp, signIn } from '@/test/utils';
import { CompanyRecords } from './CompanyRecords';
import { Companies } from './Companies';
import { CompanyOnboardingItems } from './settings/CompanyOnboardingItems';

const A = '5b0c1d4e-0000-4000-8000-000000000001';
const B2 = '5b0c1d4e-0000-4000-8000-000000000002';
beforeEach(() => resetCompanies());

/** The checklist applies to nobody until Settings says so. */
async function setApplies() {
  renderApp(<CompanyOnboardingItems />);
  await userEvent.click(await screen.findByTestId('coi-req-safety_induction-cw_contractor'));
  await userEvent.click(screen.getByTestId('coi-req-safety_induction-te_vendor'));
  await userEvent.click(screen.getByTestId('coi-save'));
  const dlg = await screen.findByTestId('coi-dialog');
  await userEvent.type(within(dlg).getByRole('textbox'), 'Needed before work starts');
  await userEvent.click(within(dlg).getByRole('button', { name: /save|confirm|submit|حفظ|تأكيد/i }));
  await waitFor(() => expect(screen.queryByTestId('coi-dialog')).not.toBeInTheDocument());
}

describe('company onboarding and bulk (0746)', () => {
  it('the checklist is empty for a company until an item is set for its type', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/companies/:id" element={<CompanyRecords />} /></Routes>, { route: `/companies/${A}` });
    expect(await screen.findByTestId('company-onb-none')).toBeInTheDocument();
  });

  it('bulk sets one item on the picked companies and the list shows progress', async () => {
    await signIn('pm');
    await setApplies();
    cleanup();
    renderApp(<Companies />);
    await userEvent.click(await screen.findByTestId(`company-pick-${A}`));
    await userEvent.click(screen.getByTestId(`company-pick-${B2}`));
    await userEvent.selectOptions(screen.getByTestId('companies-bulk-item'), 'safety_induction');
    await userEvent.selectOptions(screen.getByTestId('companies-bulk-status'), 'approved');
    await userEvent.click(screen.getByTestId('companies-bulk-apply'));
    await waitFor(() => expect(screen.getByTestId(`company-onb-progress-${A}`).textContent).toMatch(/1/));
  });
});
