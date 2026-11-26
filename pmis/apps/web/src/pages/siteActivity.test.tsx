import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { Site } from './Site';

const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;

/** Site Master Activity tab: the Audit Log rows of the site through the existing endpoint (server scope rules decide the content). */
describe('Site Activity tab', () => {
  it('opens for an auditor and shows a stream, an empty state or a notice, never an error', async () => {
    await signIn('auditor');
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(2)}?tab=activity` });
    expect(await screen.findByTestId('site-section-activity')).toHaveAttribute('aria-selected', 'true');
    await screen.findByTestId(/site-activity(-empty|-forbidden)?$/);
    expect(screen.queryByTestId('site-activity-error')).toBeNull();
  });
});
