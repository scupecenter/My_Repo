import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { resetWorkflowEditorMock } from '@/mocks/handlers.workflowEditor';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Workflow Studio lists: three tables, search, filters, sort, inline edit with one saved batch, the unsaved warning. */
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


describe('Workflow Studio lists', () => {
  beforeEach(() => { resetWorkflowEditorMock(); });
  it('opens on the task list with the three tabs, searches, filters and sorts', async () => {
    const u = userEvent.setup();
    await open();
    await screen.findByTestId('studio-lists');
    expect(screen.getByTestId('studio-table-tasks')).toBeInTheDocument();
    expect(screen.getByTestId('studio-trow-A1')).toBeInTheDocument();
    await u.type(screen.getByTestId('studio-search'), 'B2');
    expect(screen.queryByTestId('studio-trow-A1')).toBeNull();
    expect(screen.getByTestId('studio-trow-B2')).toBeInTheDocument();
    await u.clear(screen.getByTestId('studio-search'));
    await u.selectOptions(screen.getByTestId('studio-filter-ms'), 'MS2');
    expect(screen.queryByTestId('studio-trow-A1')).toBeNull();
    await u.selectOptions(screen.getByTestId('studio-filter-ms'), '');
    await u.click(screen.getByTestId('studio-sort-code'));
    await u.click(screen.getByTestId('studio-sort-code'));
    expect(screen.getByTestId('studio-sort-code').closest('th')).toHaveAttribute('aria-sort', 'descending');
    await u.click(screen.getByTestId('studio-view-milestones'));
    expect(await screen.findByTestId('studio-table-milestones')).toBeInTheDocument();
    expect(screen.getByTestId('studio-mrow-MS1')).toBeInTheDocument();
    await u.click(screen.getByTestId('studio-view-gates'));
    expect(await screen.findByTestId('studio-table-gates')).toBeInTheDocument();
  }, 60_000);

  it('edits a name in the cell: the change waits (amber, counted, publish off), then one reason saves it', async () => {
    const u = userEvent.setup();
    await open();
    await u.click(await screen.findByTestId('studio-en-A1'));
    const inp = screen.getByTestId('studio-en-A1-input');
    await u.clear(inp); await u.type(inp, 'Site acceptance report{Enter}');
    expect(screen.getByTestId('studio-en-A1')).toHaveAttribute('data-dirty', 'true');
    expect(screen.getByTestId('studio-unsaved-count')).toHaveTextContent('1 change waiting');
    expect(screen.getByTestId('studio-review-btn')).toBeDisabled();
    await u.click(screen.getByTestId('studio-unsaved-save'));
    await reasonAndSave(u);
    await waitFor(() => expect(screen.queryByTestId('studio-unsaved')).toBeNull());
    expect(screen.getByTestId('studio-en-A1')).toHaveTextContent('Site acceptance report');
    await waitFor(() => expect(screen.getByTestId('studio-pending')).toHaveTextContent('1 pending change'));
  }, 60_000);

  it('cancels a cell with Escape, discards the waiting changes, and refuses an empty English name', async () => {
    const u = userEvent.setup();
    await open();
    await u.click(await screen.findByTestId('studio-en-A1'));
    await u.type(screen.getByTestId('studio-en-A1-input'), 'xx{Escape}');
    expect(screen.queryByTestId('studio-unsaved')).toBeNull();
    await u.click(screen.getByTestId('studio-en-A1'));
    await u.clear(screen.getByTestId('studio-en-A1-input'));
    await u.keyboard('{Enter}');
    expect(screen.getByTestId('studio-unsaved-bad')).toBeInTheDocument();
    expect(screen.getByTestId('studio-unsaved-save')).toBeDisabled();
    await u.click(screen.getByTestId('studio-unsaved-discard'));
    expect(screen.queryByTestId('studio-unsaved')).toBeNull();
  }, 60_000);

  it('asks before the page is closed while a change waits, and the pen still opens the full form', async () => {
    const u = userEvent.setup();
    await open();
    await u.click(await screen.findByTestId('studio-ar-A1'));
    await u.type(screen.getByTestId('studio-ar-A1-input'), 'مهمة{Enter}');
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await u.click(screen.getByTestId('studio-pen-A1'));
    expect(await screen.findByTestId('studio-task-form')).toHaveAttribute('data-code', 'A1');
    await u.click(screen.getByTestId('studio-show-lists'));
    expect(await screen.findByTestId('studio-unsaved-count')).toHaveTextContent('1 change waiting');
  }, 60_000);
});
