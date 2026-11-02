import { screen, waitFor, within } from '@testing-library/react';
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

  it('shows the coming-soon page for a key that is not a register', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('nothing'));
    expect(await screen.findByTestId('page-register-soon')).toBeInTheDocument();
  });
});

describe('Manual entry: create, submit, approve (L1 then L2)', () => {
  it('walks a procurement record through both levels', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    await chooseSite(u);
    await u.selectOptions(screen.getByTestId('reg-field-scope'), 'CW');
    await u.selectOptions(screen.getByTestId('reg-field-delivery'), 'Outsourced');
    await u.type(screen.getByTestId('reg-field-order_status'), 'Open'); // a free list until the owner fixes its values (Q95)
    await u.type(screen.getByTestId('reg-field-pr_no'), 'PR-2026-100');
    await u.click(screen.getByTestId('reg-submit'));
    // two fixed levels: the submission goes straight to L2 (no middle review step)
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('In approval'));
    expect(screen.queryByTestId('reg-review')).not.toBeInTheDocument();
    await u.click(await screen.findByTestId('reg-approve'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('Approved'));
    const list = await api.get<{ items: RegisterRecord[] }>('/registers/procurement/records');
    expect(list.items.find((r) => r.data.pr_no === 'PR-2026-100')?.state).toBe('approved');
  }, 30_000);

  it('says in plain words what is wrong and keeps Submit off until it is fixed', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    await chooseSite(u);
    await u.selectOptions(screen.getByTestId('reg-field-delivery'), 'In-House');
    await u.type(screen.getByTestId('reg-field-pr_no'), 'PR-1');
    await u.click(screen.getByTestId('reg-submit'));
    expect(await screen.findByTestId('reg-error-scope')).toHaveTextContent('Scope is required.');
    expect(screen.getByTestId('reg-error-pr_no')).toHaveTextContent('An in-house order has no purchase request');
    expect(screen.getByTestId('reg-submit')).toBeDisabled();
    expect(screen.getByTestId('reg-missing')).toBeInTheDocument();
  });

  it('refuses a rejection without a note and returns the record to L1 (Entry) with it', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement', `?record=${recId(4)}`));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('reg-reject'));
    await u.click(screen.getByTestId('reject-submit'));
    expect(screen.getByTestId('reject-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('reject-note'), 'PR date is missing');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('Entry')); // two levels: a rejection from L2 goes back to L1
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
    await u.selectOptions(screen.getByTestId('reg-field-permit_type'), 'Access - CW');
    await u.selectOptions(screen.getByTestId('reg-field-status'), 'Approved');
    await u.type(screen.getByTestId('reg-field-valid_from'), '2026-09-10');
    expect(screen.getByTestId('reg-field-has_expiry')).toBeChecked();
    expect(screen.getByTestId('reg-field-valid_to')).toBeInTheDocument();
    await u.click(screen.getByTestId('reg-submit'));
    expect(await screen.findByTestId('reg-error-valid_to')).toHaveTextContent('Valid To is required.');
    await u.click(screen.getByTestId('reg-field-has_expiry'));
    expect(screen.queryByTestId('reg-field-valid_to')).not.toBeInTheDocument();
    expect(screen.getByTestId('reg-permanent')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-error-valid_to')).not.toBeInTheDocument();
    await u.click(screen.getByTestId('reg-submit'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('In approval'));
    const items = (await api.get<{ items: RegisterRecord[] }>('/registers/permits_hse/records')).items;
    const mine = items.find((r) => r.state === 'in_approval' && r.data.permit_type === 'Access - CW' && r.data.has_expiry === false);
    expect(mine).toBeTruthy();
    expect(mine!.data.valid_to).toBeUndefined();
  });

  it('shows the PTW checks only for a permit-to-work type', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('permits_hse'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    expect(screen.queryByTestId('reg-section-ptw')).not.toBeInTheDocument();
    await u.selectOptions(await screen.findByTestId('reg-field-permit_type'), 'PTW - CW');
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
    await u.type(screen.getByTestId('reg-field-installation_date'), '2026-10-10');
    await u.type(screen.getByTestId('reg-field-tx_link_tested_date'), '2026-10-01');
    await u.click(screen.getByTestId('reg-submit'));
    expect(await screen.findByTestId('reg-error-tx_link_tested_date')).toHaveTextContent(/cannot be earlier than Installation Date/);
  });
});

describe('Template entry', () => {
  const uploadThroughDialog = async (u: ReturnType<typeof userEvent.setup>, name: string, body = 'x') => {
    await u.click(await screen.findByTestId('more-menu')); // secondary tools live in "More" (plan T3)
    await waitFor(() => expect(screen.getByTestId('register-template-upload')).toBeEnabled());
    await u.click(screen.getByTestId('register-template-upload'));
    await u.upload(await screen.findByTestId('template-upload-file'), new File([body], name));
    await u.click(screen.getByTestId('template-upload-submit'));
  };

  it('downloads the template (blank and pre-filled), uploads a filled one, reviews the diff, sends it into the flow and L2 decides row by row and all at once', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('more-menu'));
    await waitFor(() => expect(screen.getByTestId('register-template-upload')).toBeEnabled());
    expect(screen.getByTestId('register-template-download')).toBeEnabled();
    expect(screen.getByTestId('register-template-prefill')).toBeEnabled();
    await u.keyboard('{Escape}');
    await uploadThroughDialog(u, 'filled.xlsx');
    await screen.findByTestId('page-register-batch');
    await waitFor(() => expect(screen.getByTestId('batch-count-valid')).toHaveTextContent('4 valid'), { timeout: 4000 });
    expect(screen.getByTestId('batch-status')).toHaveTextContent('Checked');
    expect(screen.getByTestId('batch-count-invalid')).toHaveTextContent('2 invalid');
    // the reasons per cell (the column header, then a plain sentence) and the diff per cell
    expect(screen.getByTestId('batch-reason-7')).toHaveTextContent('Site ID: Unknown site, or a site outside your regions.');
    expect(screen.getByTestId('batch-cell-error-7-site_code')).toBeInTheDocument();
    expect(screen.getByTestId('batch-diff-old-4-order_status')).toHaveTextContent('Open');
    expect(screen.getByTestId('batch-diff-new-4-order_status')).toHaveTextContent('Issued');
    expect(screen.getByTestId('batch-diff-2-pr_no')).toHaveTextContent('PR-2026-11');
    // nothing is a record yet: the rows wait for the uploader
    expect(screen.queryByTestId('batch-row-approve-2')).not.toBeInTheDocument();
    await u.click(screen.getByTestId('batch-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('In approval'));
    expect(screen.getByTestId('batch-steps').querySelector('[aria-current="step"]')).toHaveTextContent(/In the flow/);
    // L2 returns one row with a note, approves another, then approves what is left
    await u.click(await screen.findByTestId('batch-row-reject-2'));
    await u.type(await screen.findByTestId('reject-note'), 'Wrong PR date');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-decision-2')).toHaveTextContent('Returned'));
    expect(screen.getByTestId('batch-note-2')).toHaveTextContent('Wrong PR date');
    await u.click(screen.getByTestId('batch-row-approve-3'));
    await waitFor(() => expect(screen.getByTestId('batch-decision-3')).toHaveTextContent('Approved'));
    expect(screen.getByTestId('batch-status')).toHaveTextContent('Partly approved');
    await u.click(screen.getByTestId('batch-approve-all'));
    await waitFor(() => expect(screen.getByTestId('batch-done')).toBeInTheDocument());
    expect(screen.getByTestId('batch-status')).toHaveTextContent('Approved');
    const items = (await api.get<{ items: RegisterRecord[] }>('/registers/procurement/records')).items;
    const created = items.find((r) => r.data.pr_no === 'PR-2026-12');
    expect(created).toMatchObject({ state: 'approved', source: 'template' });
    expect(items.find((r) => r.data.pr_no === 'PR-2026-11')).toMatchObject({ state: 'entry', last_return_note: 'Wrong PR date' });   // back at Entry, with the note
    const updated = items.find((r) => r.entity_id === recId(1));
    expect(updated).toMatchObject({ version_no: 2, state: 'approved', source: 'template' });
    expect(updated?.data.order_status).toBe('Issued');
    // the history of the new version says it came through the batch
    const steps = await api.get<{ items: { batch_row_id?: string }[] }>(`/registers/procurement/records/${updated!.id}/history`);
    expect(steps.items.every((s) => !!s.batch_row_id)).toBe(true);
  });

  it('holds a row whose record has an open version, lists it, and "approve all" leaves it alone', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    await api.post(`/registers/procurement/records/${recId(1)}/versions`, { version: 1 });       // an open version of the approved record
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    await uploadThroughDialog(u, 'filled.xlsx');
    await screen.findByTestId('page-register-batch');
    await waitFor(() => expect(screen.getByTestId('batch-count-held')).toHaveTextContent('1 held'));
    expect(screen.getByTestId('batch-held')).toHaveTextContent('1 row(s) wait for the previous version');
    expect(screen.getByTestId('batch-decision-5')).toHaveTextContent('Held: previous version open');
    await u.click(screen.getByTestId('batch-submit'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('In approval'));
    expect(screen.getByTestId('batch-outcome-held')).toHaveTextContent('1 row(s) are held');
    await u.click(await screen.findByTestId('batch-approve-all'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('Partly approved'));
    expect(screen.getByTestId('batch-decision-5')).toHaveTextContent('Held: previous version open');   // untouched
    expect(screen.getByTestId('batch-held-5')).toBeInTheDocument();
  });

  it('shows the server reason in the dialog for an old template version, a missing _tpl and a changed header', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    await uploadThroughDialog(u, 'old_template.xlsx', 'retired');
    const err = await screen.findByTestId('template-upload-error');
    expect(err).toHaveAttribute('data-reason', 'outdated_version');
    expect(err).toHaveTextContent('older version of the template');
    expect(screen.getByTestId('template-upload-detail')).toHaveTextContent('version 1 of TPL-PO; the current version is 2');
    expect(err).toHaveTextContent('written to the System Log');
    expect(screen.getByTestId('template-upload-dialog')).toBeInTheDocument();                       // the dialog stays open, no batch page
    await u.upload(screen.getByTestId('template-upload-file'), new File(['notpl'], 'plain.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    await waitFor(() => expect(screen.getByTestId('template-upload-error')).toHaveAttribute('data-reason', 'tpl_missing'));
    await u.upload(screen.getByTestId('template-upload-file'), new File(['tampered'], 'headers.xlsx'));
    await u.click(screen.getByTestId('template-upload-submit'));
    await waitFor(() => expect(screen.getByTestId('template-upload-error')).toHaveAttribute('data-reason', 'checksum_mismatch'));
    expect(screen.queryByTestId('page-register-batch')).not.toBeInTheDocument();
  });

  it('discards a batch that was not sent', async () => {
    await signIn('pm');
    renderApp(<Routed />, at('procurement'));
    const u = userEvent.setup();
    await uploadThroughDialog(u, 'filled.xlsx');
    await u.click(await screen.findByTestId('batch-discard'));
    await waitFor(() => expect(screen.getByTestId('batch-status')).toHaveTextContent('Discarded'));
    expect(screen.getByTestId('batch-discarded')).toBeInTheDocument();
    expect(screen.queryByTestId('batch-submit')).not.toBeInTheDocument();
  });
});


describe('Matrix: self-approval and empty cell', () => {
  it('warns before publishing when one person would hold every level (B5) and shows each cell rule', async () => {
    await signIn('pm');
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    const u = userEvent.setup();
    expect(await screen.findByTestId('matrix-rule-site_release-1')).toHaveTextContent('Rule: Any one holder');
    expect(screen.getByTestId('matrix-warn-self-final_closure')).toHaveTextContent('holds L1 and L2 of Final Closure'); // one person at L1 and L2: shown in advance
    expect(screen.queryByTestId('matrix-warn-self-site_release')).not.toBeInTheDocument();
    await u.click(within(screen.getByTestId('matrix-cell-site_release-3')).getByTestId('matrix-add'));
    await u.type(await screen.findByTestId('matrix-picker-q'), 'Mona');
    await u.click(await screen.findByTestId('matrix-opt-user-1102'));
    expect(await screen.findByTestId('matrix-warn-self-site_release')).toHaveTextContent('Mona Fathi holds L1 and L2 of Site Release');
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
    expect(await screen.findByTestId('matrix-error')).toHaveTextContent('Site Release: L2 (Reviewer & Approver) has no holder');
    expect(screen.getByTestId('matrix-cell-site_release-3')).toHaveAttribute('data-refused', 'true');
  }, 30_000);
});
