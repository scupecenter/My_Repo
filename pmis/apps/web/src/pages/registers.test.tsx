import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import type { RegisterRecord } from '@/api/types';
import { recId } from '@/mocks/registersData';
import { renderApp, signIn } from '@/test/utils';
import { MatrixPage } from './Matrix';
import { RegisterPage } from './Register';
import { RegisterBatch } from './RegisterBatch';

const Routed = () => (
  <Routes>
    <Route path="/registers/:key" element={<RegisterPage />} />
    <Route path="/registers/:key/batches/:batchId" element={<RegisterBatch />} />
  </Routes>
);
const at = (key: string, q = '') => ({ route: `/registers/${key}${q}` });

async function chooseSite(u: ReturnType<typeof userEvent.setup>, code = 'TR101') {
  await u.type(await screen.findByTestId('reg-site-search'), code);
  await u.click(await screen.findByTestId(`reg-site-opt-${code}`));
}

describe('Register list', () => {
  it('shows site, region, status chips, filters and an Export button', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement'));
    const row = await screen.findByTestId(`reg-row-${recId(1)}`);
    expect(within(row).getByText('TR101')).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText('Tripoli')).toBeInTheDocument());
    expect(screen.getByTestId(`reg-state-${recId(1)}`)).toHaveTextContent('Approved');
    expect(screen.getByTestId(`reg-state-${recId(2)}`)).toHaveTextContent('In review');
    expect(screen.getByTestId('register-export')).toBeInTheDocument();
    expect(screen.getByTestId('register-owner-note')).toHaveTextContent(/GECOL team and the HLC team/);
    const u = userEvent.setup();
    await u.selectOptions(screen.getByTestId('register-filter-state'), 'entry');
    await waitFor(() => expect(screen.getByTestId('register-count')).toHaveTextContent('1'));
  });

  it('shows a record that is the source of a task with a link to the task (Q43)', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement', `?record=${recId(1)}`));
    const link = await screen.findByTestId('reg-source-link');
    expect(link).toHaveTextContent('B1');
    expect(link.getAttribute('href')).toMatch(/^\/sites\/.+\?task=/);
  });

  it('shows the coming-soon page for a register that is not built yet', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('warehouse'));
    expect(await screen.findByTestId('page-register-soon')).toBeInTheDocument();
  });
});

describe('Manual entry: create, submit, review, approve', () => {
  it('walks a procurement record through every level', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    await chooseSite(u);
    await u.selectOptions(screen.getByTestId('reg-field-scope'), 'cw');
    await u.selectOptions(screen.getByTestId('reg-field-delivery'), 'outsourced');
    await u.selectOptions(screen.getByTestId('reg-field-order_status'), 'open');
    await u.type(screen.getByTestId('reg-field-pr_no'), 'PR-2026-100');
    await u.click(screen.getByTestId('reg-submit'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('In review'));
    await u.click(await screen.findByTestId('reg-review'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('In approval'));
    await u.click(await screen.findByTestId('reg-approve'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('Approved'));
    const list = await api.get<{ items: RegisterRecord[] }>('/registers/procurement/records');
    expect(list.items.find((r) => r.data.pr_no === 'PR-2026-100')?.state).toBe('approved');
  });

  it('says in plain words what is wrong and keeps Submit off until it is fixed', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    await chooseSite(u);
    await u.selectOptions(screen.getByTestId('reg-field-delivery'), 'in_house');
    await u.type(screen.getByTestId('reg-field-pr_no'), 'PR-1');
    await u.click(screen.getByTestId('reg-submit'));
    expect(await screen.findByTestId('reg-error-scope')).toHaveTextContent('Scope is required.');
    expect(screen.getByTestId('reg-error-pr_no')).toHaveTextContent('An in-house order has no purchase request');
    expect(screen.getByTestId('reg-submit')).toBeDisabled();
    expect(screen.getByTestId('reg-missing')).toBeInTheDocument();
  });

  it('refuses a rejection without a note and returns the record one level back with it', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement', `?record=${recId(4)}`));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('reg-reject'));
    await u.click(screen.getByTestId('reject-submit'));
    expect(screen.getByTestId('reject-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('reject-note'), 'PR date is missing');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('In review'));
    const r = await api.get<RegisterRecord>(`/registers/procurement/records/${recId(4)}`);
    expect(r.last_return_note).toBe('PR date is missing');
    expect(r.return_count).toBe(1);
  });

  it('rolls back the optimistic state when the server refuses (stale version)', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement', `?record=${recId(2)}`));
    const u = userEvent.setup();
    const btn = await screen.findByTestId('reg-review');
    const r = await api.get<RegisterRecord>(`/registers/procurement/records/${recId(2)}`);
    await api.post(`/registers/procurement/records/${recId(2)}/reject`, { version: r.version, body: { note: 'someone else returned it' } });
    await u.click(btn);
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveAttribute('data-kind', 'err'));
    expect(screen.getByTestId('toast')).toHaveTextContent(/Someone changed this/);
  });
});

describe('Permits: has expiry date (Q63c)', () => {
  it('Yes shows a required expiry date; No hides it and marks the permit permanent', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('permits_hse'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    await chooseSite(u);
    await u.selectOptions(screen.getByTestId('reg-field-type'), 'access_cw');
    await u.selectOptions(screen.getByTestId('reg-field-status'), 'applied');
    expect(screen.getByTestId('reg-field-has_expiry')).toBeChecked();
    expect(screen.getByTestId('reg-field-valid_to')).toBeInTheDocument();
    await u.click(screen.getByTestId('reg-submit'));
    expect(await screen.findByTestId('reg-error-valid_to')).toHaveTextContent('Valid To is required.');
    await u.click(screen.getByTestId('reg-field-has_expiry'));
    expect(screen.queryByTestId('reg-field-valid_to')).not.toBeInTheDocument();
    expect(screen.getByTestId('reg-permanent')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-error-valid_to')).not.toBeInTheDocument();
    await u.click(screen.getByTestId('reg-submit'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('In review'));
    const items = (await api.get<{ items: RegisterRecord[] }>('/registers/permits_hse/records')).items;
    const mine = items.find((r) => r.state === 'in_review' && r.data.type === 'access_cw' && r.data.has_expiry === false);
    expect(mine).toBeTruthy();
    expect(mine!.data.valid_to).toBeUndefined();
  });

  it('shows the PTW checks only for a permit-to-work type', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('permits_hse'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    expect(screen.queryByTestId('reg-section-ptw')).not.toBeInTheDocument();
    await u.selectOptions(await screen.findByTestId('reg-field-type'), 'ptw_cw');
    expect(screen.getByTestId('reg-section-ptw')).toBeInTheDocument();
  });
});

describe('GECOL and HLC ownership (Q56, Q55)', () => {
  it('lets the GECOL team enter its own purchase request, one row per site', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('gecol'));
    const u = userEvent.setup();
    expect(await screen.findByTestId('register-owner-note')).toHaveTextContent(/own purchase request/);
    await u.click(screen.getByTestId('register-new'));
    await chooseSite(u, 'TR101'); // TR101 already has a GECOL row
    await u.type(screen.getByTestId('reg-field-pr_no'), 'GPR-9');
    await u.type(screen.getByTestId('reg-field-survey_date'), '2026-10-01');
    await u.click(screen.getByTestId('reg-save'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent(/already has a row/));
  });

  it('counts the HLC request as a purchase request and checks the chronology', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('hlc'));
    const u = userEvent.setup();
    expect(await screen.findByTestId('register-owner-note')).toHaveTextContent(/counts as a purchase request/);
    await u.click(screen.getByTestId('register-new'));
    await chooseSite(u, 'WM103');
    await u.type(screen.getByTestId('reg-field-install_date'), '2026-10-10');
    await u.type(screen.getByTestId('reg-field-tx_tested_date'), '2026-10-01');
    await u.click(screen.getByTestId('reg-submit'));
    expect(await screen.findByTestId('reg-error-tx_tested_date')).toHaveTextContent(/cannot be earlier than Installation Date/);
  });
});

describe('Template entry', () => {
  it('downloads the template, uploads a filled one, reviews the batch row by row and approves the rest', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('register-template-upload')).toBeEnabled());
    expect(screen.getByTestId('register-template-download')).toBeEnabled();
    fireEvent.change(screen.getByTestId('register-template-file'), { target: { files: [new File(['x'], 'filled.xlsx')] } });
    await screen.findByTestId('page-register-batch');
    await waitFor(() => expect(screen.getByTestId('batch-count-valid')).toHaveTextContent('4 valid'), { timeout: 4000 });
    expect(screen.getByTestId('batch-count-invalid')).toHaveTextContent('2 invalid');
    expect(screen.getByTestId('batch-reason-6')).toHaveTextContent('Site ID: Site not in the Site Register.');
    await u.click(screen.getByTestId('batch-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('In review'));
    await u.click(await screen.findByTestId('batch-row-reject-2'));
    await waitFor(() => expect(screen.getByTestId('batch-decision-2')).toHaveTextContent('Returned'));
    await u.click(screen.getByTestId('batch-approve-all'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('In approval'));
    await u.click(await screen.findByTestId('batch-approve-all'));
    await waitFor(() => expect(screen.getByTestId('batch-done')).toBeInTheDocument());
    const items = (await api.get<{ items: RegisterRecord[] }>('/registers/procurement/records')).items;
    expect(items.filter((r) => String(r.data.pr_no).startsWith('PR-2026-1') && r.state === 'approved' && r.id !== recId(1)).length).toBeGreaterThanOrEqual(2);
  });

  it('rejects an old template version with a plain reason', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement'));
    await waitFor(() => expect(screen.getByTestId('register-template-upload')).toBeEnabled());
    fireEvent.change(screen.getByTestId('register-template-file'), { target: { files: [new File(['retired'], 'old_template.xlsx')] } });
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('This template version is retired'));
  });
});

describe('Matrix: self-approval and empty cell', () => {
  it('warns before publishing when one person would hold every level (B5) and shows each cell rule', async () => {
    await signIn('pm');
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    const u = userEvent.setup();
    expect(await screen.findByTestId('matrix-rule-site_release-1')).toHaveTextContent('Rule: Any one holder');
    expect(screen.getByTestId('matrix-warn-self-final_closure')).toHaveTextContent('holds every level of Final Closure'); // one level, one holder: shown in advance
    expect(screen.queryByTestId('matrix-warn-self-site_release')).not.toBeInTheDocument();
    await u.click(within(screen.getByTestId('matrix-cell-site_release-3')).getByTestId('matrix-add'));
    await u.type(await screen.findByTestId('matrix-picker-q'), 'Mona');
    await u.click(await screen.findByTestId('matrix-opt-user-1102'));
    expect(await screen.findByTestId('matrix-warn-self-site_release')).toHaveTextContent('Mona Fathi holds every level of Site Release');
  });

  it('names the level that has no holder when the server answers empty_cell', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    const u = userEvent.setup();
    const cell = await screen.findByTestId('matrix-cell-site_release-3');
    await u.click(within(cell).getByTestId(/^holder-remove-/));
    await u.click(screen.getByTestId('matrix-publish'));
    await u.type(screen.getByTestId('matrix-reason'), 'Test empty');
    await u.click(screen.getByTestId('matrix-publish-confirm'));
    expect(await screen.findByTestId('matrix-error')).toHaveTextContent('Site Release, level 3 has no holder');
    expect(screen.getByTestId('matrix-cell-site_release-3')).toHaveAttribute('data-refused', 'true');
  });
});
