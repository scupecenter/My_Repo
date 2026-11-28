import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SitePlannedDates } from '@/components/SitePlannedDates';
import { PlanRules } from '@/pages/settings/PlanRules';
import { renderApp, signIn } from '@/test/utils';
import { api } from '@/api/client';

const SITE = '11111111-1111-4111-8111-111111111111';

// A4 (contract 0.15.463): the proposals show only when they differ, and change nothing until the engineer confirms.
describe('planned dates', () => {
  it('lists the proposals, confirms the ticked tasks and then hides the panel', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const { id } = await api.get<{ items: { id: string }[] }>('/sites', { query: { limit: 1 } }).then((r) => r.items[0]!);
    renderApp(<SitePlannedDates siteId={id} />);
    const open = await screen.findByTestId('site-planned-open');
    expect(open).toHaveAttribute('aria-label');
    await u.click(open);
    expect(await screen.findByTestId('planned-row-B2')).toBeInTheDocument();
    expect(screen.getByTestId('planned-row-B3')).toBeInTheDocument();
    await u.click(screen.getByRole('checkbox', { name: /B3/ }));
    await u.click(screen.getByRole('button', { name: /Confirm 1/ }));
    await waitFor(() => expect(screen.queryByTestId('site-planned-dates')).not.toBeInTheDocument());
    void SITE;
  });

  it('saves the rules with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<PlanRules />);
    const basis = await screen.findByTestId('plan-rules-basis');
    await u.selectOptions(basis, 'min');
    await u.click(screen.getByTestId('plan-rules-save'));
    await u.type(await screen.findByTestId('plan-rules-dialog-reason'), 'shorter plan');
    await u.click(screen.getByTestId('plan-rules-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('plan-rules-version')).toHaveTextContent('1'));
  });
});
