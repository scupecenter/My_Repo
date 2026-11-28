import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import { resetWorkflowEditorMock } from '@/mocks/handlers.workflowEditor';
import { SITE_FIELD_ID } from '@/mocks/handlers.siteColumns';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/**
 * Workflow Studio S3 (contract 0.15.43): the Site Master columns of a task and the "New Site Master column" add tab. The synthetic columns of
 * `mocks/handlers.siteColumns.ts`: task A1 fills N (date), O (dropdown), P (protected, approved date), Q (text); task A4 fills GF (added, no value),
 * GG (added, holds values) and GH (added, inactive).
 */
type U = ReturnType<typeof userEvent.setup>;
const REASON = 'The owner asked for it';
const page = (locale: 'en' | 'ar' = 'en') => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/workflow/editor', locale });
const asked = async (u: U, dlg: string) => { await u.type(await screen.findByTestId(`${dlg}-reason`), REASON); await u.click(screen.getByTestId(`${dlg}-submit`)); };
async function openTask(u: U, code: string, locale: 'en' | 'ar' = 'en') {
  await signIn('pm');
  await api.post('/__mock/step-up');
  await api.post('/workflow/versions', { body: { parent_version: 1, reason: REASON } });
  page(locale);
  await screen.findByTestId('studio-ms-MS1');
  await u.click(screen.getByTestId('studio-ms-toggle-MS1'));
  await u.click(await screen.findByTestId(`studio-task-${code}`));
  await screen.findByTestId('studio-col-table');
}
const actions = async (u: U, ord: number) => { await u.click(screen.getByTestId(`studio-col-actions-${ord}`)); return screen.findByTestId(`studio-col-menu-${ord}`); };
/** Records every request of the column routes, then lets the mock answer. */
function record(): { method: string; path: string; body: unknown; ifMatch: string | null }[] {
  const log: { method: string; path: string; body: unknown; ifMatch: string | null }[] = [];
  const on = (method: string) => async ({ request }: { request: Request }) => {
    const text = await request.clone().text();
    log.push({ method, path: new URL(request.url).pathname.replace(/^.*\/site-master/, ''), body: text ? JSON.parse(text) : null, ifMatch: request.headers.get('If-Match') });
    return undefined;
  };
  server.use(
    http.post(`${API_BASE}/site-master/columns`, on('POST')), http.patch(`${API_BASE}/site-master/columns/:ord`, on('PATCH')), http.post(`${API_BASE}/site-master/columns/:ord/type-preview`, on('POST')),
    http.post(`${API_BASE}/site-master/columns/:ord/deactivate`, on('POST')), http.post(`${API_BASE}/site-master/columns/:ord/reactivate`, on('POST')), http.delete(`${API_BASE}/site-master/columns/:ord`, on('DELETE')),
    http.patch(`${API_BASE}/site-master/columns/:ord/sections`, on('PATCH')),
  );
  return log;
}

describe('Workflow Studio, Site Master columns of a task', () => {
  beforeEach(() => resetWorkflowEditorMock());

  it('lists the columns whose source is the task: letter, name, type, dropdown list with its name, menus as chips, state', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1');
    expect(screen.getByTestId('studio-col-table')).toHaveAttribute('aria-label', 'Site Master columns filled by task A1');
    for (const l of ['N', 'O', 'P', 'Q']) expect(screen.getByTestId(`studio-col-row-${l}`)).toBeInTheDocument();
    expect(screen.queryByTestId('studio-col-row-R')).toBeNull();
    expect(screen.getByTestId('studio-col-name-N')).toHaveTextContent('SAR Planned Date');
    expect(screen.getByTestId('studio-col-type-N')).toHaveTextContent('Date');
    expect(screen.getByTestId('studio-col-type-O')).toHaveTextContent('Dropdown list');
    expect(screen.getByTestId('studio-col-list-O')).toHaveTextContent('Action status');
    expect(screen.getByTestId('studio-col-list-O')).toHaveTextContent('ActionStatus');
    expect(screen.getByTestId('studio-col-list-N')).toHaveTextContent('None');
    expect(screen.getByTestId('studio-col-menu-O-design_acq')).toHaveTextContent('Design & Acquisition');
    expect(screen.getByTestId('studio-col-menu-O-sow')).toHaveTextContent('SOW');
    expect(screen.getByTestId('studio-col-state-N')).toHaveTextContent('Active');
    expect(screen.getByTestId('studio-col-protected-P')).toBeInTheDocument();
    expect(screen.getByTestId('studio-col-protected-P').getAttribute('title')).toBeTruthy(); // hover explains why it is protected
    expect(screen.queryByTestId('studio-col-protected-N')).toBeNull();
    // another task: its own columns, one of them inactive
    await u.click(screen.getByTestId('studio-task-A4'));
    await waitFor(() => expect(screen.getByTestId('studio-col-row-GF')).toBeInTheDocument());
    expect(screen.getByTestId('studio-col-state-GH')).toHaveTextContent('Inactive');
    expect(screen.queryByTestId('studio-col-row-N')).toBeNull();
    // a task with no column shows the empty state
    await u.click(screen.getByTestId('studio-task-A2'));
    await waitFor(() => expect(screen.getByTestId('studio-col-row-R')).toBeInTheDocument());
    await u.click(await screen.findByTestId('studio-ms-toggle-MS2'));
    await u.click(await screen.findByTestId('studio-task-B1'));
    expect(await screen.findByTestId('studio-master-empty')).toBeInTheDocument();
  }, 90_000);

  it('shows the Arabic name in Arabic', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1', 'ar');
    expect(screen.getByTestId('studio-col-name-N')).toHaveTextContent('تاريخ التخطيط لتقرير المسح');
    expect(screen.getByTestId('studio-col-actions-14')).toHaveAttribute('aria-label', 'إجراءات العمود N');
  }, 90_000);

  it('adds a column from the task: "+ Add column" opens the column tab with the task preset and sends the right body', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1');
    const log = record();
    await u.click(screen.getByTestId('studio-col-add'));
    expect(await screen.findByTestId('studio-add-column')).toBeInTheDocument();
    expect(screen.getByTestId('studio-add-tab-column')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('studio-add-col-task')).toHaveValue('A1');
    expect(await screen.findByTestId('studio-add-col-after')).toHaveValue('17');
    expect(screen.getByTestId('studio-add-col-band')).toHaveValue('RF & DESIGN');
    expect(screen.getByTestId('studio-add-col-group')).toHaveValue('Survey');
    await waitFor(() => expect(screen.getByTestId('studio-add-col-letter')).toHaveTextContent('GJ'));
    expect(screen.getByTestId('studio-add-submit')).toBeDisabled();
    await u.type(screen.getByTestId('studio-add-col-en'), 'SAR Review Date');
    await u.type(screen.getByTestId('studio-add-col-ar'), 'تاريخ مراجعة المسح');
    await u.selectOptions(screen.getByTestId('studio-add-col-type'), 'date');
    await u.selectOptions(screen.getByTestId('studio-add-col-key'), 'actual_start');
    await u.click(screen.getByTestId('studio-add-col-menu-sow'));
    await u.click(screen.getByTestId('studio-add-submit'));
    await asked(u, 'studio-reason-dialog');
    await waitFor(() => expect(log.find((x) => x.method === 'POST' && x.path === '/columns')).toBeTruthy());
    expect(log.find((x) => x.path === '/columns')?.body).toEqual({
      name_en: 'SAR Review Date', name_ar: 'تاريخ مراجعة المسح', group_top: 'RF & DESIGN', group_mid: 'Survey', after_ord: 17, value_type: 'date',
      source: { kind: 'task_input', task_code: 'A1', field_key: 'actual_start' }, sections: ['sow'], reason: REASON,
    });
    // back on the task form, the new column is in its table with the letter the API gave
    expect(await screen.findByTestId('studio-col-row-GJ')).toBeInTheDocument();
    expect(screen.getByTestId('studio-col-name-GJ')).toHaveTextContent('SAR Review Date');
    expect(screen.getByTestId('studio-col-state-GJ')).toHaveTextContent('Active');
  }, 90_000);

  it('adds a list column from the add menu with a site custom field as the source and refuses a list type without a list', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1');
    const log = record();
    await u.click(screen.getByTestId('studio-add-menu'));
    await u.click(await screen.findByTestId('studio-menu-column'));
    expect(await screen.findByTestId('studio-add-column')).toBeInTheDocument();
    await u.type(screen.getByTestId('studio-add-col-en'), 'Tower Owner');
    await u.selectOptions(screen.getByTestId('studio-add-col-type'), 'list');
    expect(screen.getByTestId('studio-add-submit')).toBeDisabled();
    await u.selectOptions(await screen.findByTestId('studio-add-col-list'), 'RiskStatus');
    await u.click(screen.getByTestId('studio-add-col-src-field'));
    const pick = await screen.findByTestId('studio-add-col-field');
    expect(within(pick).queryByText(/Near airport/)).toBeNull();   // that field feeds a column already
    await u.selectOptions(pick, SITE_FIELD_ID);
    await u.click(screen.getByTestId('studio-add-submit'));
    await asked(u, 'studio-reason-dialog');
    await waitFor(() => expect(log.find((x) => x.path === '/columns')).toBeTruthy());
    const b = log.find((x) => x.path === '/columns')?.body as Record<string, unknown>;
    expect(b).toMatchObject({ name_en: 'Tower Owner', value_type: 'list', list_catalogue: 'RiskStatus', source: { kind: 'site_field', field_id: SITE_FIELD_ID }, after_ord: 17 });
    expect(b).not.toHaveProperty('sections');
    expect(await screen.findByTestId('studio-form-title')).toBeInTheDocument();   // the add screen closed
  }, 90_000);

  it('shows the error of the API inline in the reason dialog (a duplicate header)', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1');
    await u.click(screen.getByTestId('studio-col-add'));
    await u.type(await screen.findByTestId('studio-add-col-en'), 'SAR Planned Date');
    await u.selectOptions(screen.getByTestId('studio-add-col-key'), 'planned_start');
    await u.click(screen.getByTestId('studio-add-submit'));
    await asked(u, 'studio-reason-dialog');
    expect(await screen.findByTestId('studio-reason-dialog-error')).toHaveTextContent('A column with this header exists already.');
    expect(screen.getByTestId('studio-add-column')).toBeInTheDocument();
  }, 90_000);

  it('changes the type: the preview runs first and counts the values that would not convert, then the PATCH confirms them', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1');
    const log = record();
    await actions(u, 14);
    await u.click(screen.getByTestId('studio-col-type-14'));
    const dlg = await screen.findByTestId('studio-col-type-dialog');
    await u.selectOptions(within(dlg).getByTestId('studio-col-type-select'), 'number');
    expect(screen.getByTestId('studio-col-type-dialog-submit')).toBeDisabled();
    await u.click(within(dlg).getByTestId('studio-col-preview'));
    const res = await within(dlg).findByTestId('studio-col-preview-result');
    expect(res).toHaveTextContent('2 of 2 stored values would not convert.');
    expect(within(dlg).getByTestId('studio-col-preview-samples')).toHaveTextContent('TRP-0001: 2026-03-01');
    expect(screen.getByTestId('studio-col-type-dialog-submit')).toBeDisabled();   // the admin must accept first
    await u.click(within(dlg).getByTestId('studio-col-accept'));
    await asked(u, 'studio-col-type-dialog');
    await waitFor(() => expect(screen.queryByTestId('studio-col-type-dialog')).toBeNull());
    expect(log.map((x) => `${x.method} ${x.path}`)).toEqual(['POST /columns/14/type-preview', 'PATCH /columns/14']);
    expect(log[0]!.body).toEqual({ value_type: 'number', list_catalogue: null });
    expect(log[1]!.body).toEqual({ value_type: 'number', confirm_unconvertible: true, reason: REASON });
    expect(log[1]!.ifMatch).toBe('"1"');
    await waitFor(() => expect(screen.getByTestId('studio-col-type-N')).toHaveTextContent('Number'));
  }, 90_000);

  it('changes a type with nothing to lose without the confirmation flag, and changes the dropdown list of a list column', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1');
    const log = record();
    // Q is text with one value: text to text-like yes/no would fail, so use "list" on a column of dropdown values instead: change the list of O
    await actions(u, 15);
    await u.click(screen.getByTestId('studio-col-list-15'));
    const dlg = await screen.findByTestId('studio-col-type-dialog');
    expect(within(dlg).queryByTestId('studio-col-type-select')).toBeNull();
    expect(within(dlg).getByTestId('studio-col-list-select')).toHaveValue('ActionStatus');
    await u.selectOptions(within(dlg).getByTestId('studio-col-list-select'), 'RiskStatus');
    await u.click(within(dlg).getByTestId('studio-col-preview'));
    // Done, Open, Blocked against Open, Monitoring, Closed, Materialized: Done and Blocked do not fit
    expect(await within(dlg).findByTestId('studio-col-preview-result')).toHaveAttribute('data-bad', '2');
    await u.click(within(dlg).getByTestId('studio-col-accept'));
    await asked(u, 'studio-col-type-dialog');
    await waitFor(() => expect(screen.getByTestId('studio-col-list-O')).toHaveTextContent('RiskStatus'));
    expect(log.at(-1)?.body).toEqual({ value_type: 'list', list_catalogue: 'RiskStatus', confirm_unconvertible: true, reason: REASON });
    // a column with no stored value: the preview says so and no confirmation flag is sent
    await u.click(screen.getByTestId('studio-task-A2'));
    await screen.findByTestId('studio-col-row-R');
    log.length = 0;
    await actions(u, 18);
    await u.click(screen.getByTestId('studio-col-type-18'));
    const d2 = await screen.findByTestId('studio-col-type-dialog');
    await u.selectOptions(within(d2).getByTestId('studio-col-type-select'), 'number');
    await u.click(within(d2).getByTestId('studio-col-preview'));
    expect(await within(d2).findByTestId('studio-col-preview-result')).toHaveTextContent('The column holds no values');
    expect(within(d2).queryByTestId('studio-col-accept')).toBeNull();
    await asked(u, 'studio-col-type-dialog');
    await waitFor(() => expect(screen.queryByTestId('studio-col-type-dialog')).toBeNull());
    expect(log.at(-1)?.body).toEqual({ value_type: 'number', reason: REASON });
  }, 90_000);

  it('renames in English and Arabic and changes the menus (the existing sections route)', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1');
    const log = record();
    await actions(u, 17);
    await u.click(screen.getByTestId('studio-col-rename-17'));
    const ren = await screen.findByTestId('studio-col-rename-dialog');
    expect(within(ren).getByTestId('studio-col-name-en')).toHaveValue('SAR Surveyor Notes');
    await u.clear(within(ren).getByTestId('studio-col-name-en'));
    await u.type(within(ren).getByTestId('studio-col-name-en'), 'SAR Notes');
    await u.type(within(ren).getByTestId('studio-col-name-ar'), 'ملاحظات المسح');
    await asked(u, 'studio-col-rename-dialog');
    await waitFor(() => expect(screen.getByTestId('studio-col-name-Q')).toHaveTextContent('SAR Notes'));
    expect(log.at(-1)).toMatchObject({ method: 'PATCH', path: '/columns/17', body: { name_en: 'SAR Notes', name_ar: 'ملاحظات المسح', reason: REASON }, ifMatch: '"1"' });
    // menus: the column is in design_acq; add cw
    await actions(u, 17);
    await u.click(screen.getByTestId('studio-col-menus-17'));
    const m = await screen.findByTestId('studio-col-menus-dialog');
    expect(within(m).getByTestId('studio-col-menu-pick-design_acq')).toBeChecked();
    await u.click(within(m).getByTestId('studio-col-menu-pick-cw'));
    await asked(u, 'studio-col-menus-dialog');
    await waitFor(() => expect(screen.getByTestId('studio-col-menu-Q-cw')).toBeInTheDocument());
    expect(log.at(-1)).toMatchObject({ path: '/columns/17/sections', body: { sections: ['design_acq', 'cw'], reason: REASON } });
  }, 90_000);

  it('a protected column allows only the rename and the menus: the other actions are off with the reason, delete is not offered', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1');
    await actions(u, 16);
    expect(screen.getByTestId('studio-col-rename-16')).toBeEnabled();
    expect(screen.getByTestId('studio-col-menus-16')).toBeEnabled();
    for (const k of ['type', 'list', 'deactivate']) {
      const b = screen.getByTestId(`studio-col-${k}-16`);
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', 'A milestone date: the workflow fills it.');
    }
    expect(screen.queryByTestId('studio-col-delete-16')).toBeNull();
    // the same column of an original, not protected: type and deactivate are on, the list is off because it is not a list column
    await u.keyboard('{Escape}');
    await actions(u, 14);
    expect(screen.getByTestId('studio-col-type-14')).toBeEnabled();
    expect(screen.getByTestId('studio-col-deactivate-14')).toBeEnabled();
    expect(screen.getByTestId('studio-col-list-14')).toBeDisabled();
    expect(screen.getByTestId('studio-col-list-14')).toHaveAttribute('title', 'Only a dropdown list column has a list.');
  }, 90_000);

  it('deactivates and reactivates with a reason and the column version', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1');
    const log = record();
    await actions(u, 14);
    await u.click(screen.getByTestId('studio-col-deactivate-14'));
    await asked(u, 'studio-reason-dialog');
    await waitFor(() => expect(screen.getByTestId('studio-col-state-N')).toHaveTextContent('Inactive'));
    expect(log.at(-1)).toMatchObject({ method: 'POST', path: '/columns/14/deactivate', body: { reason: REASON }, ifMatch: '"1"' });
    await actions(u, 14);
    expect(screen.queryByTestId('studio-col-deactivate-14')).toBeNull();
    await u.click(screen.getByTestId('studio-col-reactivate-14'));
    await asked(u, 'studio-reason-dialog');
    await waitFor(() => expect(screen.getByTestId('studio-col-state-N')).toHaveTextContent('Active'));
    expect(log.at(-1)).toMatchObject({ path: '/columns/14/reactivate', ifMatch: '"2"' });
  }, 90_000);

  it('offers delete only for an added column that never held a value, and deletes it', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A4');
    await screen.findByTestId('studio-col-row-GF');
    const log = record();
    // GG holds values: deactivate only
    await actions(u, 189);
    expect(screen.getByTestId('studio-col-deactivate-189')).toBeEnabled();
    expect(screen.queryByTestId('studio-col-delete-189')).toBeNull();
    await u.keyboard('{Escape}');
    // GF never held a value: delete is there (the usage is read first)
    await actions(u, 188);
    await waitFor(() => expect(screen.getByTestId('studio-col-delete-188')).toBeInTheDocument());
    await u.click(screen.getByTestId('studio-col-delete-188'));
    await asked(u, 'studio-reason-dialog');
    await waitFor(() => expect(screen.queryByTestId('studio-col-row-GF')).toBeNull());
    expect(log.at(-1)).toMatchObject({ method: 'DELETE', path: '/columns/188', ifMatch: '"1"' });
    // an original column of the first task never offers it
    await u.click(screen.getByTestId('studio-task-A1'));
    await screen.findByTestId('studio-col-row-N');
    await actions(u, 14);
    expect(screen.queryByTestId('studio-col-delete-14')).toBeNull();
  }, 90_000);

  it('a stale version (412) is shown inline and the list is read again', async () => {
    const u = userEvent.setup();
    await openTask(u, 'A1');
    await actions(u, 17);
    await u.click(screen.getByTestId('studio-col-rename-17'));
    const ren = await screen.findByTestId('studio-col-rename-dialog');
    // somebody else renames it first: the column is at version 2
    await api.patch('/site-master/columns/17', { version: 1, body: { name_en: 'Changed elsewhere', reason: REASON } });
    await u.clear(within(ren).getByTestId('studio-col-name-en'));
    await u.type(within(ren).getByTestId('studio-col-name-en'), 'My name');
    await asked(u, 'studio-col-rename-dialog');
    expect(await screen.findByTestId('studio-col-rename-dialog-error')).toHaveTextContent('Someone changed this column');
    await waitFor(() => expect(screen.getByTestId('studio-col-name-Q')).toHaveTextContent('Changed elsewhere'));
  }, 90_000);
});
