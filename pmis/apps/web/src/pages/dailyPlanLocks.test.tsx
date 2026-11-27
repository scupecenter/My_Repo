import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { resetDailyPlanMock } from '@/mocks/handlers.dailyPlan';
import { renderApp, signIn } from '@/test/utils';

// Hardening layer 1b (migration 0566): the Daily Plan shows the plan lock, the row lock and the column locks to a System Admin.
beforeEach(() => resetDailyPlanMock());

describe('Daily Plan locks (0566)', () => {
  it('a System Admin locks a column for every plan and sees it listed', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/my-work/daily-plan?date=2026-11-22' });
    const u = userEvent.setup();
    await u.selectOptions(await screen.findByTestId('daily-plan-column-locks-select'), 'remark');
    await u.click(screen.getByTestId('daily-plan-column-locks-lock'));
    await u.type(screen.getByTestId('daily-plan-column-locks-dialog-reason'), 'Remarks are closed');
    await u.click(screen.getByTestId('daily-plan-column-locks-dialog-submit'));
    expect(await screen.findByTestId('daily-plan-column-locks-open-remark')).toBeInTheDocument();
  }, 20_000);

  it('a System Admin locks a plan and the badge shows', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/my-work/daily-plan?date=2026-11-22' });
    const u = userEvent.setup();
    const btn = (await screen.findAllByTestId(/^daily-plan-entity-lock-\d+$/))[0]!;
    await u.click(btn);
    await u.type(await screen.findByLabelText(/reason/i), 'Plan frozen');
    await u.click(screen.getByRole('button', { name: /^(save|confirm|ok|lock)$/i }));
    await waitFor(() => expect(screen.getAllByTestId(/^daily-plan-entity-lock-\d+-badge$/).length).toBeGreaterThan(0));
  }, 20_000);

  it('a user without System Admin sees no entity lock controls', async () => {
    await signIn('reviewer');
    renderApp(<App />, { route: '/my-work/daily-plan?date=2026-11-22' });
    await screen.findByTestId('daily-plan-toolbar');
    expect(screen.queryByTestId('daily-plan-column-locks')).not.toBeInTheDocument();
  }, 20_000);
});
