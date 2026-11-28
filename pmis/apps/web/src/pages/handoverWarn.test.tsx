import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

/** A8: the readiness handover asks for a confirmation when snags, issues or quality records are still open on the site. It warns and never blocks. */
async function openForm(u: ReturnType<typeof userEvent.setup>) {
  await u.click(await screen.findByTestId('register-new'));
  await u.type(await screen.findByTestId('reg-site-search'), 'TR101');
  await u.click(await screen.findByTestId('reg-site-opt-TR101'));
  await u.type(screen.getByTestId('reg-field-title'), 'Handover of TR101');
}

describe('Readiness handover: open items warning', () => {
  it('shows the open counts on submit and lets the user go back or submit anyway', async () => {
    await signIn('pm');
    // the mock site has nothing open, so the site page answers with counts (the shape the API returns)
    server.use(http.get(`${API_BASE}/sites/:id`, () => HttpResponse.json({ counts: { open_snags: 2, open_issues: 1, documents_missing: 0 } })));
    renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: '/registers/readiness_handover' });
    const u = userEvent.setup();
    await openForm(u);
    await waitFor(() => expect(screen.getByTestId('reg-submit')).toBeEnabled());
    await u.click(screen.getByTestId('reg-submit'));
    const warn = await screen.findByTestId('reg-handover-warn');
    expect(screen.getByTestId('reg-handover-counts')).toHaveTextContent('Open snags: 2. Open issues: 1. Quality records not yet approved: 0.');
    await u.click(screen.getByTestId('reg-handover-cancel'));
    expect(warn).not.toBeInTheDocument();
    await u.click(screen.getByTestId('reg-submit'));
    await u.click(await screen.findByTestId('reg-handover-confirm'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('In approval'));
  }, 30_000);

  it('does not ask when nothing is open', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: '/registers/readiness_handover' });
    const u = userEvent.setup();
    await openForm(u);
    await u.click(screen.getByTestId('reg-submit'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toBeInTheDocument());
    expect(screen.queryByTestId('reg-handover-warn')).toBeNull();
  }, 30_000);
});
