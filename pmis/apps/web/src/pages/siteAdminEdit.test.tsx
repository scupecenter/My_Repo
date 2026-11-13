import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { resetQcMocks, siteAdminEdits } from '@/mocks/handlers.qc';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { Site } from './Site';

/** Owner decision 2026-11-12 (2), contract 0.15.6: a System Admin edits a site directly (reason + step-up), the edit is flagged and can be reverted; others see no such form. */
const SITE = siteIdOf(2);
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;

beforeEach(() => resetQcMocks());
afterEach(() => cleanup());

describe('Edit (admin) on the site page', () => {
  it('is not offered to a person who is not a System Admin', async () => {
    await signIn('engineer');
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    await screen.findByTestId('site-identity');
    expect(screen.queryByTestId('site-admin-edit')).toBeNull();
  });

  it('applies an edit at once with a reason, shows the Admin override badge, and reverts it', async () => {
    await signIn('pm');
    db().session!.stepupAt = Date.now();
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    await u.click(await screen.findByTestId('site-admin-open'));
    const form = await screen.findByTestId('site-admin-form');
    expect(within(form).getByTestId('site-admin-apply')).toBeDisabled();
    const name = within(form).getByTestId('site-admin-name');
    await u.clear(name);
    await u.type(name, 'Corrected name');
    expect(within(form).getByTestId('site-admin-apply')).toBeDisabled();            // a reason is required
    await u.type(within(form).getByTestId('site-admin-reason'), 'Owner correction');
    await u.click(within(form).getByTestId('site-admin-apply'));
    await waitFor(() => expect(siteAdminEdits).toHaveLength(1));
    expect(siteAdminEdits[0]!.after).toMatchObject({ name: 'Corrected name' });
    expect(await screen.findByTestId('site-admin-badge')).toBeInTheDocument();
    await u.click(await screen.findByTestId(`site-admin-revert-${siteAdminEdits[0]!.id}`));
    await u.type(await screen.findByTestId('site-admin-revert-reason'), 'Wrong site');
    await u.click(screen.getByTestId('site-admin-revert-send'));
    await waitFor(() => expect(siteAdminEdits[0]!.reverted_at).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId('site-admin-badge')).toBeNull());
  });
});
