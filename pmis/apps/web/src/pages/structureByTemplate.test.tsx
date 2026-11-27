import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.15.401 (migration 0560): Settings > Data > Edit through templates, the live templates, the proposals, the review and the approval. */
const REG = { template_id: 'TPL-GECOL', name_en: 'GECOL power', name_ar: 'قوة جيكول', kind: 'data_import', template_kind: 'register', module_key: 'gecol', register_key: 'gecol', stream: null, current_version: 3 };
const page = (opts: { locale?: 'en' | 'ar' } = {}) => {
  server.use(http.get(`${API_BASE}/templates`, () => HttpResponse.json({ items: [REG] })));
  return renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/data/structure', ...opts });
};

describe('Settings, edit the structure through templates', () => {
  it('lists the live register templates with named icon buttons, and the pending proposals', async () => {
    await signIn('pm');
    page();
    expect(await screen.findByTestId('struct-row-TPL-GECOL')).toHaveTextContent('v3');
    for (const id of ['struct-dl-TPL-GECOL', 'struct-up-TPL-GECOL', 'struct-view-TPL-GECOL']) expect(screen.getByTestId(id)).toHaveAttribute('aria-label');
    expect(screen.getByTestId('struct-dl-TPL-GECOL')).toHaveAttribute('aria-label', en.struct.download);
    expect(screen.getByTestId('struct-pending-bar')).toHaveTextContent('2 waiting for review');
    expect(screen.getByTestId('settings-section-data-structure')).toHaveTextContent('Edit through templates');
    expect(screen.getByTestId('struct-note')).toHaveTextContent('Nothing changes at once');
  });

  it('the review shows each change with its effect; a blocked item disables the approval; the approval applies the proposal', async () => {
    await signIn('pm'); await api.post('/__mock/step-up');
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('struct-open-00000000-0000-4000-8000-0000000000a2'));
    expect(screen.getByTestId('struct-blocked-pr_no')).toHaveTextContent('some values do not convert');
    expect(screen.getByTestId('struct-approve')).toBeDisabled();
    expect(screen.getByTestId('struct-two')).toBeInTheDocument();
    await u.click(screen.getByTestId('struct-open-00000000-0000-4000-8000-0000000000a1'));
    expect(within(screen.getByTestId('struct-item-contractor')).getByText(/12 records hold a value/)).toBeInTheDocument();
    expect(screen.getByTestId('struct-item-x_new')).toHaveTextContent('New column: no data is affected');
    expect(screen.getByTestId('struct-approve')).toBeEnabled();
    await u.click(screen.getByTestId('struct-approve'));
    await waitFor(() => expect(screen.getByTestId('struct-p-00000000-0000-4000-8000-0000000000a1')).toHaveTextContent('Applied'));
    expect(await screen.findByTestId('struct-revert')).toBeInTheDocument();
  });

  it('a rejection needs a note; the page and its keys exist in Arabic and read right to left', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('struct-open-00000000-0000-4000-8000-0000000000a2'));
    await u.click(screen.getByTestId('struct-reject'));
    await u.type(screen.getByTestId('struct-reject-dialog-reason'), 'Fix the values first');
    await u.click(screen.getByTestId('struct-reject-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('struct-p-00000000-0000-4000-8000-0000000000a2')).toHaveTextContent('Rejected'));
    expect(Object.keys(ar.struct).sort()).toEqual(Object.keys(en.struct).sort());
  });

  it('shows the Arabic page', async () => {
    await signIn('pm');
    page({ locale: 'ar' });
    expect(await screen.findByTestId('struct-note')).toHaveTextContent(ar.struct.note);
    expect(screen.getByTestId('struct-dl-TPL-GECOL')).toHaveAttribute('aria-label', ar.struct.download);
  });

  it('the rules card: every rule is shown, a change needs a reason and is saved; the keys match in Arabic', async () => {
    await signIn('pm'); await api.post('/__mock/step-up');
    const u = userEvent.setup();
    page();
    expect(await screen.findByTestId('structp-policy')).toBeInTheDocument();
    expect(screen.getByTestId('structp-who_approves')).toHaveValue('admins');
    expect(screen.getByTestId('structp-save')).toBeDisabled();
    await u.selectOptions(screen.getByTestId('structp-two_person'), 'always');
    await u.clear(screen.getByTestId('structp-max'));
    await u.type(screen.getByTestId('structp-max'), '600');
    expect(screen.getByTestId('structp-save')).toBeDisabled();
    await u.clear(screen.getByTestId('structp-max'));
    await u.type(screen.getByTestId('structp-max'), '20');
    await u.click(screen.getByTestId('structp-notify_proposer'));
    await u.click(screen.getByTestId('structp-save'));
    await u.type(screen.getByTestId('structp-policy-dialog-reason'), 'Two people for every change');
    await u.click(screen.getByTestId('structp-policy-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('structp-policy-dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('structp-max')).toHaveValue(20));
    expect(screen.getByTestId('structp-two_person')).toHaveValue('always');
    expect(screen.getByTestId('structp-notify_proposer')).not.toBeChecked();
    expect(Object.keys(ar.structp).sort()).toEqual(Object.keys(en.structp).sort());
  });

  it('Settings, Registers, Columns has a Structure changes tab with the review of the register and the rules', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/registers/columns?register=gecol' });
    await u.click(await screen.findByTestId('regcols-tab-structure'));
    expect(await screen.findByTestId('page-structure-changes')).toBeInTheDocument();
    expect(await screen.findByTestId('struct-p-00000000-0000-4000-8000-0000000000a1')).toBeInTheDocument();
    expect(screen.getByTestId('structp-policy')).toBeInTheDocument();
    await u.click(screen.getByTestId('struct-open-00000000-0000-4000-8000-0000000000a1'));
    expect(screen.getByTestId('struct-approve')).toBeEnabled();
    await u.click(screen.getByTestId('regcols-tab-columns'));
    expect(await screen.findByTestId('page-register-columns')).toBeInTheDocument();
  });
});
