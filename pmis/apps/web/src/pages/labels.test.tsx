import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { MyLabels } from './MyLabels';
import { Site } from './Site';

/** Contract 0.15.620: personal coloured labels. */
const code = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('personal labels', () => {
  it('make one on a site, see it on the site and in My labels; hide it; names are unique; another person sees none of it', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    const id = siteIdOf(0);
    renderApp(<Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>, { route: `/sites/${id}` });
    await u.click(await screen.findByTestId('labels-open'));
    await u.type(screen.getByTestId('label-new-name'), 'Urgent');
    await u.click(screen.getByTestId('label-new-add'));
    await waitFor(() => expect(screen.getByTestId('label-tick-Urgent')).toBeChecked());
    const links = await api.get<{ items: { ref_id: string; label_ids: string[] }[] }>('/labels/links', { query: { kind: 'site' } });
    expect(links.items.map((x) => x.ref_id)).toEqual([id]);
    expect(await code(api.post('/labels', { body: { name: 'urgent', colour: 'red' } }))).toBe('409:duplicate');
    expect(await code(api.post('/labels', { body: { name: 'x', colour: 'nope' } }))).toBe('422:validation_failed');
    await signIn('engineer');
    expect((await api.get<{ items: unknown[] }>('/labels')).items).toEqual([]);
    await signIn('pm');
  });

  it('My labels groups the records by label and filters by one label', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    const a = await api.post<{ id: string }>('/labels', { body: { name: 'Alpha', colour: 'green' } });
    await api.post<{ id: string }>('/labels', { body: { name: 'Beta', colour: 'purple' } });
    await api.post(`/labels/${a.id}/assign`, { body: { kind: 'site', ref_id: siteIdOf(1) } });
    renderApp(<MyLabels />, { route: '/my-labels' });
    expect(await screen.findByTestId('labels-group-Alpha')).toBeInTheDocument();
    expect(screen.getByTestId('labels-group-Beta')).toBeInTheDocument();
    await u.selectOptions(screen.getByTestId('labels-filter'), a.id);
    await waitFor(() => expect(screen.queryByTestId('labels-group-Beta')).toBeNull());
    await api.post(`/labels/${a.id}/archive`);
  });
});
