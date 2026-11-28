import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { SiteCompare } from './SiteCompare';

/** Compare two sites (0.15.483): pick a second site, see both side by side, the stage difference is the second minus the first. */
describe('compare two sites', () => {
  it('picks a second site and shows the task counts and the stage difference', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<SiteCompare siteId="00000000-0000-4000-8000-000000000001" />);
    await u.type(screen.getByTestId('sc-search'), '10');
    const pick = (await screen.findAllByTestId(/^sc-pick-/))[0]!;
    await u.click(pick);
    expect(await screen.findByTestId('sc-result')).toHaveTextContent('Overdue');
    expect(screen.getByTestId('sc-diff-MS1')).toHaveTextContent('+15');
    expect(screen.getByTestId('sc-diff-MS2')).toHaveTextContent('—');
    await u.click(screen.getByTestId('sc-change'));
    expect(screen.getByTestId('sc-search')).toBeTruthy();
  });
});
