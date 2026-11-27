import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { DataHubPage } from './DataHub';

const Routed = () => (<Routes><Route path="/data-hub" element={<DataHubPage />} /></Routes>);
const summary = {
  batches: { count: 2, items: [{ id: 'b1', file_name: 'Permits.xlsx', action: 'send', status: 'validated', template_id: 'TPL-PERMITS', template_version: 1, register_key: 'permits_hse', stream: null, counts: { valid: 3, invalid: 0 } }] },
  template_changes: [{ template_id: 'TPL-GECOL', name_en: 'GECOL', version: 2, issued_at: '2026-11-20T00:00:00Z', added: ['A'], removed: [], renamed: [], mine_is_old: true }],
  my_downloads: [{ template_id: 'TPL-GECOL', version: 1, prefill: false, at: '2026-11-26T10:00:00Z' }],
};

describe('Data hub landing', () => {
  it('shows the widgets, the count badge and the last downloads', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/data-hub/summary`, () => HttpResponse.json(summary)));
    renderApp(<Routed />, { route: '/data-hub' });
    expect(await screen.findByTestId('hub-widget-batches')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('hub-badge-batches')).toHaveTextContent('2'));
    expect(screen.getByTestId('hub-change-TPL-GECOL')).toHaveTextContent('v2');
    expect(screen.getByTestId('hub-my-downloads')).toHaveTextContent('2026-11-26');
    expect(screen.getByTestId('hub-widget-health')).toBeInTheDocument();
    expect(screen.getByTestId('hub-link-data-reset')).toHaveAttribute('href', '/admin/settings/data/reset');
    expect(screen.getByTestId('hub-link-recycle-bin')).toHaveAttribute('href', '/admin/settings/registers/recycle');
    expect(screen.getByTestId('hub-settings-gear')).toHaveAttribute('href', '/admin/settings/screens/data-hub');
    expect(screen.getByTestId('hub-settings-gear')).toHaveAttribute('aria-label');
  });

  it('cascading dropdowns: the action list follows the template, and a download is the same call as the card', async () => {
    await signIn('pm');
    const asked: string[] = [];
    server.use(http.get(`${API_BASE}/templates/:id/download`, ({ params, request }) => {
      asked.push(`${params.id}?${new URL(request.url).searchParams.toString()}`);
      return new HttpResponse(new Uint8Array([1]), { headers: { 'Content-Disposition': 'attachment; filename="x.xlsx"' } });
    }));
    renderApp(<Routed />, { route: '/data-hub' });
    const u = userEvent.setup();
    const tpl = await screen.findByTestId('hub-quickbar-template');
    expect(screen.getByTestId('hub-quickbar-go')).toBeDisabled();
    await u.click(tpl);
    await u.type(tpl, 'gecol');
    await u.keyboard('{Enter}');
    await u.click(screen.getByTestId('hub-quickbar-action'));
    await u.click(await screen.findByTestId('hub-quickbar-action-opt-blank'));
    await u.click(screen.getByTestId('hub-quickbar-go'));
    await waitFor(() => expect(asked).toEqual(['TPL-GECOL?']));
  });
});
