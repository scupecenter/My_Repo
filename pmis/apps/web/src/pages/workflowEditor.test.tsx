import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { resetWorkflowEditorMock } from '@/mocks/handlers.workflowEditor';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Settings, Workflow: the three-column editor (milestones, tasks, gate, detail), the lock panel, the closing task, date conditions, the table view, the mobile back step, preview then publish. */
type U = ReturnType<typeof userEvent.setup>;
const stepUpDone = () => api.post('/__mock/step-up');
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/workflow' });
const REASON = 'The owner asked for it';
const reasonAndSave = async (u: U, dlg: string) => { await u.type(await screen.findByTestId(`${dlg}-reason`), REASON); await u.click(screen.getByTestId(`${dlg}-submit`)); };
const openDraft = async (u: U) => {
  await signIn('pm'); await stepUpDone(); page();
  await u.click(await screen.findByTestId('wfe-new-draft'));
  await reasonAndSave(u, 'wfe-draft-dialog');
  await screen.findByTestId('wfe-editor');
};
const lift = async (u: U) => {
  await u.click(await screen.findByTestId('freeze-lift'));
  await u.type(screen.getByTestId('freeze-dialog-reason'), REASON);
  await u.type(screen.getByTestId('freeze-confirm'), 'structural-freeze');
  await u.click(screen.getByTestId('freeze-dialog-submit'));
  await waitFor(() => expect(screen.getByTestId('freeze-status')).toHaveTextContent('lifted'));
};
const pickMs = (code: string) => userEvent.click(within(screen.getByTestId(`wfe-stage-${code}`)).getByText(code));
const pick = (code: string, name: RegExp) => userEvent.click(within(screen.getByTestId(`wfe-task-${code}`)).getByText(name));

describe('Settings, Workflow (three columns)', () => {
  beforeEach(() => resetWorkflowEditorMock());

  it('shows the three columns, a banner while the structure is locked, and disables structural actions with the reason, while renames still work', async () => {
    const u = userEvent.setup();
    await openDraft(u);
    for (const c of ['wfe-col-milestones', 'wfe-col-tasks', 'wfe-col-gate']) expect(screen.getByTestId(c)).toBeInTheDocument();
    expect(await screen.findByTestId('wfe-frozen-banner')).toHaveTextContent(/locked until/i);
    const add = screen.getByTestId('wfe-ms-add');
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', expect.stringMatching(/locked until/i));
    expect(screen.getByTestId('wfe-ms-del-MS1')).toBeDisabled();
    expect(screen.getByTestId('wfe-publish')).toBeDisabled();
    expect(screen.getByTestId('wfe-gate-G1')).toHaveTextContent('Release to PRE-CW');
    await u.click(screen.getByTestId('wfe-ms-MS2'));
    const en = await screen.findByTestId('wfe-ms-en');
    await u.clear(en); await u.type(en, 'PRE-CW done');
    await reasonAndSave(u, 'wfe-ms-dialog');
    expect(await screen.findByText(/PRE-CW done/)).toBeInTheDocument();
  }, 60_000);

  it('lifts the lock from the top bar, adds a milestone and a gate after it, then locks again', async () => {
    const u = userEvent.setup();
    await openDraft(u);
    await lift(u);
    await waitFor(() => expect(screen.getByTestId('wfe-ms-add')).toBeEnabled());
    await pickMs('MS2');
    await u.click(screen.getByTestId('wfe-ms-add'));
    await u.type(await screen.findByTestId('wfe-ms-code'), 'MS3');
    await u.type(screen.getByTestId('wfe-ms-en'), 'Closure');
    await reasonAndSave(u, 'wfe-ms-dialog');
    expect(await screen.findByTestId('wfe-stage-MS3')).toBeInTheDocument();
    await pickMs('MS2');
    await u.click(await screen.findByTestId('wfe-gate-add'));
    await u.type(await screen.findByTestId('wfe-gate-code'), 'G2');
    await u.type(screen.getByTestId('wfe-gate-en'), 'Closure gate');
    await reasonAndSave(u, 'wfe-gate-dialog');
    expect(await screen.findByTestId('wfe-gate-G2')).toBeInTheDocument();
    // re-lock
    await u.click(screen.getByTestId('freeze-lock'));
    await u.type(await screen.findByTestId('freeze-lock-dialog-reason'), REASON);
    await u.click(screen.getByTestId('freeze-lock-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('wfe-frozen-banner')).toBeInTheDocument());
    expect(screen.getByTestId('wfe-ms-add')).toBeDisabled();
  }, 90_000);

  it('marks the task that closes the milestone from the detail panel (one per milestone) and runs a task in parallel with another', async () => {
    const u = userEvent.setup();
    await openDraft(u);
    await lift(u);
    await pick('A4', /LLD/);
    expect(await screen.findByTestId('wfe-detail-task')).toHaveTextContent('A4');
    expect(screen.getByTestId('wfe-detail-preds')).toHaveTextContent('A2 (MS1)');
    await u.click(screen.getByTestId('wfe-detail-closing'));
    await reasonAndSave(u, 'wfe-reason-dialog');
    expect(await screen.findByTestId('wfe-closing-A4')).toBeInTheDocument();
    // A2 beside A1: it gets the predecessors of A1 (none)
    await pick('A2', /TSSR/);
    await u.selectOptions(await screen.findByTestId('wfe-detail-parallel-pick'), 'A1');
    await u.click(screen.getByTestId('wfe-detail-parallel-go'));
    await reasonAndSave(u, 'wfe-reason-dialog');
    await waitFor(() => expect(screen.getByTestId('wfe-preds-A2')).toHaveTextContent('-'));
    expect(screen.getByTestId('wfe-parallel-A1')).toBeInTheDocument();
    expect(screen.getByTestId('wfe-parallel-A2')).toBeInTheDocument();
  }, 90_000);

  it('adds a date condition with a working-day offset to the gate and shows it in the column', async () => {
    const u = userEvent.setup();
    await openDraft(u);
    await u.click(await screen.findByTestId('wfe-gate-edit-G1'));
    await u.click(await screen.findByTestId('wfe-gate-cond-add-condition'));
    await u.selectOptions(screen.getByTestId('wfe-gate-cond-ctype-0'), 'date_field');
    await u.selectOptions(await screen.findByTestId('wfe-gate-cond-0-dkind'), 'site');
    await u.selectOptions(screen.getByTestId('wfe-gate-cond-0-dfield'), 'rf_survey_date');
    const off = screen.getByTestId('wfe-gate-cond-offset-0');
    await u.clear(off); await u.type(off, '2');
    await reasonAndSave(u, 'wfe-gate-dialog');
    await waitFor(() => expect(screen.getByTestId('wfe-gate-conds-G1')).toHaveTextContent(/site\.rf_survey_date.*\+2/));
  }, 60_000);

  it('edits many tasks from the table view with one reason', async () => {
    const u = userEvent.setup();
    await openDraft(u);
    await u.click(screen.getByTestId('wfe-table-toggle'));
    await u.click(await screen.findByTestId('wfe-pick-B2'));
    await u.click(screen.getByTestId('wfe-bulk-deactivate'));
    await reasonAndSave(u, 'wfe-reason-dialog');
    await waitFor(() => expect(screen.getByTestId('wfe-row-B2')).toHaveClass('opacity-60'));
    await u.click(screen.getByTestId('wfe-table-toggle'));
    expect(await screen.findByTestId('wfe-col-tasks')).toBeInTheDocument();
  }, 60_000);

  it('goes down one step at a time on a phone and comes back with the back button', async () => {
    const u = userEvent.setup();
    await openDraft(u);
    expect(screen.queryByTestId('wfe-back')).toBeNull();
    await pickMs('MS2');
    await u.click(await screen.findByTestId('wfe-back'));
    expect(screen.queryByTestId('wfe-back')).toBeNull();
    await pickMs('MS1');
    await pick('A1', /SAR/);
    expect(await screen.findByTestId('wfe-detail-task')).toBeInTheDocument();
    await u.click(screen.getByTestId('wfe-back'));
    await waitFor(() => expect(screen.getByTestId('wfe-detail-empty')).toBeInTheDocument());
    expect(screen.getByTestId('wfe-back')).toBeInTheDocument();
  }, 60_000);

  it('opens the site locks shortcut', async () => {
    const u = userEvent.setup();
    await openDraft(u);
    await u.click(screen.getByTestId('wfe-sitelocks-btn'));
    expect(await screen.findByTestId('wfe-sitelocks')).toBeInTheDocument();
    expect(screen.getByTestId('wfe-sitelocks-region')).toBeInTheDocument();
  }, 60_000);

  it('previews the impact, then publishes with the typed confirmation once the lock is lifted', async () => {
    const u = userEvent.setup();
    await openDraft(u);
    await lift(u);
    await u.click(await screen.findByTestId('wfe-ms-MS2'));
    const en = await screen.findByTestId('wfe-ms-en');
    await u.clear(en); await u.type(en, 'Renamed milestone');
    await reasonAndSave(u, 'wfe-ms-dialog');
    await waitFor(() => expect(screen.queryByTestId('wfe-ms-dialog')).toBeNull());
    await u.click(screen.getByTestId('wfe-publish'));
    const prev = await screen.findByTestId('wfe-preview-dialog');
    expect(within(prev).getByTestId('wfe-prev-cycle')).toHaveTextContent(/no loop/i);
    await u.click(screen.getByTestId('wfe-preview-dialog-submit'));
    expect(screen.getByTestId('wfe-publish-dialog-submit')).toBeDisabled();
    await u.type(await screen.findByTestId('wfe-confirm'), 'v2');
    await u.type(screen.getByTestId('wfe-publish-dialog-reason'), REASON);
    await u.click(screen.getByTestId('wfe-publish-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('wfe-version-2')).toHaveTextContent('Published'));
  }, 90_000);

  it('deletes a task added in the draft for good and discards the draft', async () => {
    const u = userEvent.setup();
    await openDraft(u);
    await u.click(await screen.findByTestId('wfe-gap-3'));
    await u.type(await screen.findByTestId('wfe-ins-code'), 'TMP1');
    await u.type(screen.getByTestId('wfe-ins-en'), 'Temp');
    await reasonAndSave(u, 'wfe-insert-dialog');
    await u.click(await screen.findByTestId('wfe-del-TMP1'));
    await reasonAndSave(u, 'wfe-remove-dialog');
    await waitFor(() => expect(screen.queryByTestId('wfe-task-TMP1')).not.toBeInTheDocument());
    await u.click(screen.getByTestId('wfe-discard'));
    await reasonAndSave(u, 'wfe-discard-dialog');
    await waitFor(() => expect(screen.queryByTestId('wfe-editor')).not.toBeInTheDocument());
  }, 60_000);
});
