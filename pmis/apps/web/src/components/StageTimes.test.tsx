import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { SiteStageTimes, StageTimesRanking } from './StageTimes';

/** Time in stage (0.15.482): the slowest stage of a site is named first with the days over plan, and the ranking lists the slowest stages. */
describe('stage times', () => {
  it('shows the stages of a site with days, planned days, rank and the slowest', async () => {
    await signIn('pm');
    renderApp(<SiteStageTimes siteId="00000000-0000-4000-8000-000000000001" />);
    expect(await screen.findByTestId('st-row-MS1')).toHaveTextContent('40 days');
    expect(screen.getByTestId('st-row-MS1')).toHaveTextContent('#1');
    expect(screen.getByTestId('st-over-MS3')).toHaveTextContent('18 days over plan');
    expect(screen.getByTestId('st-row-MS4')).toHaveTextContent('Not started');
    expect(screen.getByTestId('st-slowest')).toHaveTextContent('Acquisition');
  });

  it('ranks the slowest stages across sites', async () => {
    await signIn('pm');
    renderApp(<StageTimesRanking region="" />);
    const row = await screen.findByTestId('str-row-MS3');
    expect(row).toHaveTextContent('51.5');
    expect(row).toHaveTextContent('120');
    expect(screen.getByTestId('str-sites')).toHaveTextContent('TRP-0001');
  });
});
