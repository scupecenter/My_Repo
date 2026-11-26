import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { resetWorkflowEditorMock } from '@/mocks/handlers.workflowEditor';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Settings, Workflow, "Workflow Studio" (S1): the tree, the selection, the add menu and screen, the gate conditions, the review and publish screen. */
type U = ReturnType<typeof userEvent.setup>;
const REASON = 'The owner asked for it';
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/workflow/editor' });
const reasonAndSave = async (u: U, dlg = 'studio-reason-dialog') => { await u.type(await screen.findByTestId(`${dlg}-reason`), REASON); await u.click(screen.getByTestId(`${dlg}-submit`)); };
/** A draft of version 1 made through the API, the structural freeze lifted when asked, then the Studio on it. */
async function open({ lift = false } = {}) {
  await signIn('pm');
  await api.post('/__mock/step-up');
  await api.post('/workflow/versions', { body: { parent_version: 1, reason: REASON } });
  if (lift) {
    const f = await api.get<{ version: number }>('/settings/structural-freeze');
    await api.post('/settings/structural-freeze/lift', { version: f.version, body: { reason: REASON, confirm_text: 'structural-freeze' } });
  }
  page();
  await screen.findByTestId('studio-tree');
  await screen.findByTestId('studio-ms-MS1');
}
const expand = (u: U, ms: string) => u.click(screen.getByTestId(`studio-ms-toggle-${ms}`));

describe('Workflow Studio', () => {
  beforeEach(() => resetWorkflowEditorMock());

  it('is the default of Settings, Workflow with no link to a classic editor, chips for the live and draft versions and a tree with counts', async () => {
    await open();
    expect(screen.getByTestId('studio-chip-live')).toHaveTextContent('Live: version 1');
    expect(screen.getByTestId('studio-chip-draft')).toHaveTextContent('Draft version 2');
    expect(screen.queryByTestId('studio-classic-link')).toBeNull();
    expect(screen.getByTestId('studio-lockpanel')).toBeInTheDocument();
    expect(screen.getByTestId('studio-tree-title')).toHaveTextContent('WORKFLOW, VERSION 2 (DRAFT)');
    expect(screen.getByTestId('studio-tree-counts')).toHaveTextContent('2 milestones, 5 tasks, 1 gates');
    expect(screen.getByTestId('studio-pending')).toHaveTextContent('0 pending changes');
    expect(screen.getByTestId('studio-gate-G1')).toBeInTheDocument();
    expect(screen.getByTestId('studio-frozen-banner')).toHaveTextContent(/locked until/i);
  }, 60_000);

  it('opens a milestone to its tasks with an add row, selects a task, and filters by code or name', async () => {
    const u = userEvent.setup();
    await open();
    expect(screen.queryByTestId('studio-task-A1')).toBeNull();
    await expand(u, 'MS1');
    expect(screen.getByTestId('studio-task-A1')).toHaveTextContent('SAR');
    expect(screen.getByTestId('studio-add-task-MS1')).toHaveTextContent('Add task in Site Release');
    expect(screen.getByTestId('studio-add-task-MS1')).toBeDisabled();
    await u.click(screen.getByTestId('studio-task-A2'));
    expect(await screen.findByTestId('studio-task-form')).toHaveAttribute('data-code', 'A2');
    expect(screen.getByTestId('studio-task-A2')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('studio-form-title')).toHaveTextContent('Site Release');
    expect(screen.getByTestId('studio-after-A1')).toBeInTheDocument();
    expect(screen.getByTestId('studio-before-A4')).toBeInTheDocument();
    expect(await screen.findByTestId('studio-col-table')).toBeInTheDocument();
    expect(screen.getByTestId('studio-docs-link')).toHaveAttribute('href', '/admin/settings/documents/types');
    await u.type(screen.getByTestId('studio-search'), 'po email');
    expect(screen.getByTestId('studio-task-B2')).toBeInTheDocument();
    expect(screen.queryByTestId('studio-row-MS1')).toBeNull();
    await u.clear(screen.getByTestId('studio-search')); await u.type(screen.getByTestId('studio-search'), 'zzz');
    expect(screen.getByTestId('studio-tree-empty')).toBeInTheDocument();
  }, 60_000);

  it('selects a milestone and a gate, and a task chip selects the neighbour', async () => {
    const u = userEvent.setup();
    await open();
    await u.click(screen.getByTestId('studio-ms-MS2'));
    expect(await screen.findByTestId('studio-ms-form')).toHaveAttribute('data-code', 'MS2');
    expect(screen.getByTestId('studio-ms-task-B1')).toBeInTheDocument();
    await u.click(screen.getByTestId('studio-gate-G1'));
    const g = await screen.findByTestId('studio-gate-form');
    expect(within(g).getByTestId('studio-gate-name-en')).toHaveValue('Release to PRE-CW');
    expect(screen.getByTestId('studio-gate-opens')).toHaveTextContent('B1');
    await u.click(screen.getByTestId('studio-opens-B1'));
    expect(await screen.findByTestId('studio-task-form')).toHaveAttribute('data-code', 'B1');
    await u.click(screen.getByTestId('studio-before-B2'));
    expect(await screen.findByTestId('studio-task-form')).toHaveAttribute('data-code', 'B2');
  }, 60_000);

  it('renames a task with a reason: the tree shows the amber dot and the pending count goes up', async () => {
    const u = userEvent.setup();
    await open();
    await expand(u, 'MS1');
    await u.click(screen.getByTestId('studio-task-A1'));
    const en = await screen.findByTestId('studio-name-en');
    await u.clear(en); await u.type(en, 'Site acceptance report');
    await u.click(screen.getByTestId('studio-general-save'));
    await reasonAndSave(u);
    expect(await screen.findByTestId('studio-edited-A1')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('studio-pending')).toHaveTextContent('1 pending change'));
    expect(screen.getByTestId('studio-task-A1')).toHaveTextContent('Site acceptance report');
  }, 60_000);

  it('opens the add menu: the Site Master column is on (it is not part of the draft); task, milestone and gate are off while the structure is locked', async () => {
    const u = userEvent.setup();
    await open();
    await u.click(screen.getByTestId('studio-add-menu'));
    expect(await screen.findByTestId('studio-menu-column')).toBeEnabled();
    expect(screen.getByTestId('studio-menu-column')).toHaveTextContent('Site Master column');
    for (const k of ['task', 'milestone', 'gate']) expect(screen.getByTestId(`studio-menu-${k}`)).toBeDisabled();
    expect(screen.getByTestId('studio-menu-task')).toHaveAttribute('title', expect.stringMatching(/locked until/i));
  }, 60_000);

  it('adds a task between two others: the chain preview comes from insert-preview, then the task joins the draft', async () => {
    const u = userEvent.setup();
    await open({ lift: true });
    await expand(u, 'MS1');
    await u.click(await waitForEnabled('studio-add-task-MS1'));
    expect(await screen.findByTestId('studio-add-task')).toBeInTheDocument();
    expect(screen.getByTestId('studio-add-stage')).toHaveValue('MS1');
    await u.selectOptions(screen.getByTestId('studio-add-after'), 'A1');
    await u.selectOptions(screen.getByTestId('studio-add-before'), 'A2');
    await u.click(screen.getByTestId('studio-add-rewire'));
    expect(await screen.findByTestId('studio-add-rewire-A2')).toHaveTextContent('A1 → ? → A2');
    await u.type(screen.getByTestId('studio-add-code'), 'NEW1');
    await u.type(screen.getByTestId('studio-add-en'), 'Site photos');
    expect(await screen.findByTestId('studio-add-rewire-A2')).toHaveTextContent('A1 → NEW1 → A2');
    expect(screen.getByTestId('studio-add-matrix-link')).toHaveAttribute('href', '/admin/matrix');
    expect(screen.getByTestId('studio-add-inputs')).toHaveTextContent('Add the Site Master columns this task fills');
    // 0.15.85: the SLA is an explicit choice. Without it the task cannot be added; "no SLA" needs a short reason.
    expect(screen.getByTestId('studio-add-sla-required')).toBeInTheDocument();
    expect(screen.getByTestId('studio-add-submit')).toBeDisabled();
    await u.click(screen.getByTestId('studio-add-sla-none'));
    expect(screen.getByTestId('studio-add-submit')).toBeDisabled();
    await u.type(screen.getByTestId('studio-add-sla-none-reason'), 'Information step, no clock');
    await u.click(screen.getByTestId('studio-add-submit'));
    await reasonAndSave(u);
    expect(await screen.findByTestId('studio-task-NEW1')).toHaveTextContent('Site photos');
    expect(await screen.findByTestId('studio-task-form')).toHaveAttribute('data-code', 'NEW1');
    const v2 = await api.get<{ placements: { task_code: string; predecessors?: string[] }[] }>('/workflow/versions/2');
    expect(v2.placements.find((p) => p.task_code === 'A2')?.predecessors).toContain('NEW1');
  }, 90_000);

  it('adds a milestone from the add screen', async () => {
    const u = userEvent.setup();
    await open({ lift: true });
    await u.click(await waitForEnabled('studio-add-menu'));
    await u.click(await waitForEnabled('studio-menu-milestone'));
    expect(await screen.findByTestId('studio-add-milestone')).toBeInTheDocument();
    await u.type(screen.getByTestId('studio-add-ms-code'), 'MS3');
    await u.type(screen.getByTestId('studio-add-ms-en'), 'Closure');
    await u.click(screen.getByTestId('studio-add-submit'));
    await reasonAndSave(u);
    expect(await screen.findByTestId('studio-ms-MS3')).toBeInTheDocument();
  }, 90_000);

  it('adds a date condition to a gate with the quick buttons and saves it', async () => {
    const u = userEvent.setup();
    await open();
    await u.click(screen.getByTestId('studio-gate-G1'));
    await u.click(await screen.findByTestId('studio-gate-cond-add-date_field'));
    await u.selectOptions(await screen.findByTestId('studio-gate-cond-0-dkind'), 'site');
    const off = screen.getByTestId('studio-gate-cond-offset-0');
    await u.clear(off); await u.type(off, '2');
    await u.click(screen.getByTestId('studio-gate-save'));
    await reasonAndSave(u);
    await waitFor(async () => {
      const v2 = await api.get<{ gates: { conditions: { type: string; offset_wd?: number }[] }[] }>('/workflow/versions/2');
      expect(v2.gates[0]!.conditions).toMatchObject([{ type: 'date_field', offset_wd: 2 }]);
    });
  }, 60_000);

  it('reviews the changes with a Light badge, keeps Publish off until the reason and v2 are typed, and publishes', async () => {
    const u = userEvent.setup();
    await open({ lift: true });
    await u.click(screen.getByTestId('studio-ms-MS2'));
    const en = await screen.findByTestId('studio-ms-name-en');
    await u.clear(en); await u.type(en, 'Renamed milestone');
    await u.click(screen.getByTestId('studio-ms-save'));
    await reasonAndSave(u);
    await waitFor(() => expect(screen.getByTestId('studio-pending')).toHaveTextContent('1 pending change'));
    await u.click(screen.getByTestId('studio-review-btn'));
    const ch = await screen.findByTestId('studio-change-ms_renamed:MS2');
    expect(within(ch).getByTestId('studio-badge-light')).toHaveTextContent('Light');
    expect(await screen.findByTestId('studio-impact')).toHaveTextContent('1 open sites');
    expect(screen.getByTestId('studio-opt-sla')).toBeDisabled();
    expect(screen.getByTestId('studio-opt-new_only')).toBeChecked();
    expect(screen.getByTestId('studio-stepup-note')).toBeInTheDocument();
    expect(screen.getByTestId('studio-publish')).toBeDisabled();
    await u.type(screen.getByTestId('studio-publish-reason'), REASON);
    await u.type(screen.getByTestId('studio-publish-confirm'), 'v3');
    expect(screen.getByTestId('studio-publish')).toBeDisabled();
    await u.clear(screen.getByTestId('studio-publish-confirm')); await u.type(screen.getByTestId('studio-publish-confirm'), 'v2');
    await u.click(await waitForEnabled('studio-publish'));
    await waitFor(() => expect(screen.getByTestId('studio-chip-live')).toHaveTextContent('Live: version 2'));
    expect(screen.queryByTestId('studio-chip-draft')).toBeNull();
    expect(screen.getByTestId('studio-create-draft')).toHaveTextContent('Create draft version 3');
  }, 90_000);

  it('goes down one step at a time on a phone: the tree, then the form with a back button', async () => {
    const u = userEvent.setup();
    await open();
    await u.click(screen.getByTestId('studio-ms-MS1'));
    await screen.findByTestId('studio-ms-form');
    await u.click(screen.getByTestId('studio-back'));
    expect(screen.getByTestId('studio-tree').parentElement).not.toHaveClass('hidden');
    expect(screen.getByTestId('studio-centre')).toHaveClass('hidden');
  }, 60_000);
});

async function waitForEnabled(id: string) {
  await waitFor(() => expect(screen.getByTestId(id)).toBeEnabled());
  return screen.getByTestId(id);
}
