import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SiteDismantle } from './SiteDismantle';

const page = (items: unknown[]) => HttpResponse.json({ items, page: { limit: 100, next_cursor: null, total: items.length }, counts: { total: items.length, filtered: items.length } });

describe('Site page > Dismantle tab', () => {
  it('lists the Dismantle records of the site, with a link to the register', async () => {
    await signIn('reviewer');
    let asked = '';
    server.use(http.get(`${API_BASE}/registers/dismantle/records`, ({ request }) => {
      asked = new URL(request.url).searchParams.get('site_id') ?? '';
      return page([{ id: 'r1', register_key: 'dismantle', state: 'entry', version: 1, data: { rfd_date: '2026-11-01', supervising_engineer: 'Eng A' } }]);
    }));
    renderApp(<SiteDismantle siteId="site-1" />);
    expect(await screen.findAllByTestId('site-dismantle-row')).toHaveLength(1);
    expect(screen.getByText('Eng A')).toBeInTheDocument();
    expect(asked).toBe('site-1');
    expect(screen.getByTestId('site-dismantle-open')).toHaveAttribute('href', '/registers/dismantle');
  });

  it('says so when the site has none, and when the register is not open to the caller', async () => {
    await signIn('reviewer');
    server.use(http.get(`${API_BASE}/registers/dismantle/records`, () => page([])));
    const { unmount } = renderApp(<SiteDismantle siteId="site-2" />);
    expect(await screen.findByTestId('site-dismantle-empty')).toBeInTheDocument();
    unmount();
    server.use(http.get(`${API_BASE}/registers/dismantle/records`, () => HttpResponse.json({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden' }, { status: 403 })));
    renderApp(<SiteDismantle siteId="site-3" />);
    expect(await screen.findByTestId('site-dismantle-denied')).toBeInTheDocument();
  });
});
