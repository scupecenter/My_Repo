import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { resetDailyPlanMock } from '@/mocks/handlers.dailyPlan';
import { renderApp, signIn } from '@/test/utils';

// Hardening layer 1c (contract 0.15.410, migration 0567): History of a plan day, claim and triage of a plan day.
const DAY = '2026-11-22';
beforeEach(() => resetDailyPlanMock());

describe('Daily Plan history, claim and triage', () => {
  it('shows the history of the plan day with the field changes', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: `/my-work/daily-plan?date=${DAY}` });
    const btn = await screen.findByTestId('daily-plan-history-1');
    await u.click(btn);
    const dlg = await screen.findByTestId('daily-plan-history-dialog');
    expect(await within(dlg).findByText(/status: planned/)).toBeInTheDocument();
  });

  it('claims, accepts with a note and releases a plan day (target: region + date)', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: `/my-work/daily-plan?date=${DAY}` });
    expect(await screen.findByTestId('daily-plan-triage-1')).toHaveTextContent('Waiting for review');
    await u.click(await screen.findByTestId('daily-plan-claim-1'));
    expect(await screen.findByTestId('daily-plan-claimed-1')).toBeInTheDocument();
    await u.click(screen.getByTestId('daily-plan-accept-1'));
    const dlg = await screen.findByTestId('daily-plan-triage-dialog');
    await u.type(within(dlg).getByRole('textbox'), 'Checked with the region');
    await u.click(within(dlg).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.getByTestId('daily-plan-triage-1')).toHaveTextContent('Accepted'));
    await u.click(screen.getByTestId('daily-plan-release-1'));
    await waitFor(() => expect(screen.queryByTestId('daily-plan-claimed-1')).toBeNull());
  });

  it('shows no triage buttons to a user without L2', async () => {
    await signIn('auditor');
    renderApp(<App />, { route: `/my-work/daily-plan?date=${DAY}` });
    expect(await screen.findByTestId('daily-plan-triage-1')).toBeInTheDocument();
    expect(screen.queryByTestId('daily-plan-claim-1')).toBeNull();
  });
});
