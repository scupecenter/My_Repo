import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { resetWorkflowEditorMock } from '@/mocks/handlers.workflowEditor';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Decision 4 of 2026-11-12: Settings, Workflow. Draft, add a task, change predecessors (a cycle is shown), light edit, publish with the typed confirmation. */
const stepUpDone = () => api.post('/__mock/step-up');
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/workflow' });
const REASON = 'The owner asked for it';
const reasonAndSave = async (u: ReturnType<typeof userEvent.setup>, dlg: string) => {
  await u.type(await screen.findByTestId(`${dlg}-reason`), REASON);
  await u.click(screen.getByTestId(`${dlg}-submit`));
};

describe('Settings, Workflow', () => {
  beforeEach(() => resetWorkflowEditorMock());

  it('creates a draft, adds a task, shows a cycle error, edits a name and publishes with the typed confirmation', async () => {
    await signIn('pm');
    await stepUpDone();
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('wfe-new-draft'));
    await reasonAndSave(u, 'wfe-draft-dialog');
    const editor = await screen.findByTestId('wfe-editor');
    expect(editor).toHaveAttribute('data-status', 'draft');

    // a new task after A4, waiting for A4
    await u.click(await screen.findByTestId('wfe-add-MS1'));
    await u.type(await screen.findByTestId('wfe-code'), 'NEW1');
    await u.type(screen.getByTestId('wfe-name-en'), 'Extra inspection');
    await reasonAndSave(u, 'wfe-task-dialog');
    expect(await screen.findByTestId('wfe-task-NEW1')).toBeInTheDocument();
    await u.click(screen.getByTestId('wfe-pred-NEW1'));
    await u.click(await screen.findByTestId('wfe-pred-opt-A4'));
    await reasonAndSave(u, 'wfe-pred-dialog');
    await waitFor(() => expect(screen.getByTestId('wfe-preds-NEW1')).toHaveTextContent('A4'));

    // A1 waiting for NEW1 would close a cycle (A1 <- A2 <- A4 <- NEW1)
    await u.click(screen.getByTestId('wfe-pred-A1'));
    await u.click(await screen.findByTestId('wfe-pred-opt-NEW1'));
    await reasonAndSave(u, 'wfe-pred-dialog');
    expect(await screen.findByTestId('wfe-pred-dialog-error')).toHaveTextContent(/cycle/i);
    await u.click(within(screen.getByTestId('wfe-pred-dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('wfe-preds-A1')).toHaveTextContent('-');

    // a light edit of a milestone name
    await u.click(screen.getByTestId('wfe-ms-MS2'));
    const en = await screen.findByTestId('wfe-light-en');
    await u.clear(en);
    await u.type(en, 'PRE-CW done');
    await reasonAndSave(u, 'wfe-light-dialog');
    expect(await screen.findByText(/PRE-CW done/)).toBeInTheDocument();

    // publish: the button stays off until v2 is typed
    await u.click(screen.getByTestId('wfe-publish'));
    await u.type(await screen.findByTestId('wfe-publish-dialog-reason'), REASON);
    expect(screen.getByTestId('wfe-publish-dialog-submit')).toBeDisabled();
    await u.type(screen.getByTestId('wfe-confirm'), 'v2');
    await u.click(screen.getByTestId('wfe-publish-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('wfe-version-2')).toHaveTextContent('Published'));
    expect(screen.queryByTestId('wfe-publish')).toBeNull();
  }, 60_000);

  it('inserts a task between A1 and A2 with the chain preview, refuses a cycle, and edits successors from the dependency view', async () => {
    await signIn('pm');
    await stepUpDone();
    const u = userEvent.setup();
    page();
    await u.click(await screen.findByTestId('wfe-new-draft'));
    await reasonAndSave(u, 'wfe-draft-dialog');
    await u.click(await screen.findByTestId('wfe-insert-MS1'));
    await u.type(await screen.findByTestId('wfe-ins-code'), 'MID1');
    await u.type(screen.getByTestId('wfe-ins-en'), 'Middle step');
    await u.click(screen.getByTestId('wfe-ins-pred-opt-A1'));
    await u.click(screen.getByTestId('wfe-ins-succ-opt-A2'));
    await u.click(screen.getByTestId('wfe-ins-remove'));
    const chain = await screen.findByTestId('wfe-ins-rewire-A2');
    expect(chain).toHaveTextContent('A1');
    expect(chain).toHaveTextContent('MID1');
    expect(chain).toHaveTextContent(/old link removed/);
    // swapping the ends closes a cycle (A2 already comes after A1): the preview says so and saving is off
    await u.click(screen.getByTestId('wfe-ins-pred-opt-A1'));
    await u.click(screen.getByTestId('wfe-ins-succ-opt-A2'));
    await u.click(screen.getByTestId('wfe-ins-pred-opt-A2'));
    await u.click(screen.getByTestId('wfe-ins-succ-opt-A1'));
    expect(await screen.findByTestId('wfe-ins-cycle')).toBeInTheDocument();
    await u.type(screen.getByTestId('wfe-insert-dialog-reason'), REASON);
    expect(screen.getByTestId('wfe-insert-dialog-submit')).toBeDisabled();
    await u.click(screen.getByTestId('wfe-ins-pred-opt-A2'));
    await u.click(screen.getByTestId('wfe-ins-succ-opt-A1'));
    await u.click(screen.getByTestId('wfe-ins-pred-opt-A1'));
    await u.click(screen.getByTestId('wfe-ins-succ-opt-A2'));
    await waitFor(() => expect(screen.getByTestId('wfe-ins-rewire-A2')).toBeInTheDocument());
    await u.click(screen.getByTestId('wfe-insert-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('wfe-preds-A2')).toHaveTextContent('MID1'));
    expect(screen.getByTestId('wfe-preds-A2')).not.toHaveTextContent('A1');
    expect(screen.getByTestId('wfe-preds-MID1')).toHaveTextContent('A1');

    // the dependency view lists what waits for MID1 and lets the admin edit its successors
    await u.click(within(screen.getByTestId('wfe-deps-MS1')).getByText('Dependency chain'));
    expect(screen.getByTestId('wfe-dep-MID1')).toHaveTextContent('A2');
    await u.click(screen.getByTestId('wfe-dep-succ-MID1'));
    await u.click(await screen.findByTestId('wfe-succ-opt-A2'));
    await reasonAndSave(u, 'wfe-succ-dialog');
    await waitFor(() => expect(screen.getByTestId('wfe-preds-A2')).not.toHaveTextContent('MID1'));
  }, 60_000);
});
