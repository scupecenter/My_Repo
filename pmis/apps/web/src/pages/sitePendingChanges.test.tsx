import { cleanup, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { Site } from './Site';

/** The open Change Control drafts of a site show on the site page: state, old and new value, and the L2 note of a return. Read only (the existing change_control list). */
const SITE = siteIdOf(2);
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
afterEach(() => cleanup());

const rec = (id: string, item: string, state: string, extra: Record<string, unknown> = {}) => ({ id, register_key: 'change_control', site_id: SITE, state, is_current: true, data: { field_item: item, old_value: 'Old', new_value: 'New' }, ...extra });

describe('pending changes of a site', () => {
  it('lists a waiting draft and a returned one with its note; an approved one is not listed', async () => {
    await signIn('engineer');
    let query = '';
    server.use(http.get(`${API_BASE}/registers/change_control/records`, ({ request }) => {
      query = new URL(request.url).search;
      return HttpResponse.json({ items: [rec('r1', 'site.name', 'in_approval'), rec('r2', 'site.coordinates', 'entry', { last_return_note: 'Check the decimals', return_count: 1 }), rec('r3', 'site.name_ar', 'approved')], page: { next_cursor: null } });
    }));
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    const box = await screen.findByTestId('site-pending-changes');
    expect(query).toContain(`site_id=${SITE}`);
    expect(within(box).getByTestId('site-pending-site.name')).toHaveTextContent('Waiting for L2');
    expect(within(box).getByTestId('site-pending-site.coordinates')).toHaveTextContent('Returned');
    expect(within(box).getByTestId('site-pending-note-site.coordinates')).toHaveTextContent('Check the decimals');
    expect(within(box).queryByTestId('site-pending-site.name_ar')).toBeNull();
  });
  it('shows nothing when no draft is open', async () => {
    await signIn('engineer');
    server.use(http.get(`${API_BASE}/registers/change_control/records`, () => HttpResponse.json({ items: [], page: { next_cursor: null } })));
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    await screen.findByTestId('site-identity');
    expect(screen.queryByTestId('site-pending-changes')).toBeNull();
  });
});
