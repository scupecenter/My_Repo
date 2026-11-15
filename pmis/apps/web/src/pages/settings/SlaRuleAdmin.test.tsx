import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetWorkflowEditorMock } from '@/mocks/handlers.workflowEditor';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './Settings';

/** Settings, SLA admin: lists the rules, filters them, and keeps bulk edit disabled until a draft exists and rows are picked. */
const page = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/sla' });

describe('Settings, SLA rules bulk admin', () => {
  beforeEach(() => resetWorkflowEditorMock());

  it('lists the rules, narrows them by task code, and says that a draft is needed before bulk edit', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    page();
    const rows = await screen.findAllByTestId('sla-admin-row');
    expect(rows.length).toBeGreaterThan(0);
    await u.type(screen.getByTestId('sla-admin-text'), 'zzz-no-such-task');
    expect(screen.queryAllByTestId('sla-admin-row')).toHaveLength(0);
    expect(await screen.findByTestId('sla-admin-no-draft')).toBeInTheDocument();
  });

  it('keeps Apply disabled until rows are picked and a reason of at least 3 characters is typed', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    page();
    const first = (await screen.findAllByTestId('sla-admin-row'))[0];
    await u.click(within(first).getByRole('checkbox'));
    expect(screen.getByTestId('sla-bulk-apply')).toBeDisabled();
    await u.type(screen.getByTestId('sla-bulk-reason'), 'ok');
    expect(screen.getByTestId('sla-bulk-apply')).toBeDisabled();
  });
});
