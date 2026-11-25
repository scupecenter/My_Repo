import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { API_BASE, api } from '@/api/client';
import type { SavedView } from '@/api/views';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Dashboard } from './Dashboard';
import { Sites } from './Sites';

// ECharts draws in the browser; here the chart is a placeholder.
vi.mock('@/components/EChart', () => ({
  EChart: ({ label, testid }: { label: string; testid?: string }) => (
    <div role="img" aria-label={label} data-testid={testid} />
  ),
}));

/** Contract 0.15.49: saved views of the Site Master menus (site360-<menu>) and of the dashboard, and the server-side search of a truncated value list. */
const options = () =>
  within(screen.getByTestId('views-select'))
    .getAllByRole('option')
    .map((o) => o.textContent);
const TREE = {
  op: 'and',
  items: [{ field: 'delivery_batch', operator: 'in', value: ['B3'] }],
};
const make = (body: Record<string, unknown>) =>
  api.post<SavedView>('/saved-views', { body });
const watchRows = (): string[] => {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    const u = new URL(request.url);
    if (/\/site360\/[a-z_]+\/rows$/.test(u.pathname))
      seen.push(`${u.pathname.match(/\/site360\/([a-z_]+)\/rows$/)![1]}?${u.searchParams.toString()}`); // the menu key, whatever the API base path
  });
  return seen;
};

describe('saved views of a Site Master sub-menu', () => {
  it('belongs to the menu: saved with the tree, the quick filters and the layout, offered only on that menu, and the list stays in its own screen key', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?section=cw&region_id=1' });
    await screen.findByTestId('site-master-list');
    expect(screen.getByTestId('saved-views')).toHaveAttribute(
      'data-screen',
      'site360-cw',
    );
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'CW Tripoli');
    await u.click(screen.getByTestId('views-name-ok'));
    await waitFor(() => expect(options()).toContain('CW Tripoli'));
    // the server keeps it under the menu's own screen key, with the layout as a quick parameter
    const mine = await api.get<{ items: SavedView[] }>('/saved-views', {
      query: { screen_key: 'site360-cw' },
    });
    expect(mine.items.map((v) => v.name)).toEqual(['CW Tripoli']);
    expect(mine.items[0]!.filters).toMatchObject({
      region_id: '1',
      layout: 'list',
    });
    expect(
      (
        await api.get<{ items: SavedView[] }>('/saved-views', {
          query: { screen_key: 'site360-te' },
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await api.get<{ items: SavedView[] }>('/saved-views', {
          query: { screen_key: 'sites' },
        })
      ).items,
    ).toEqual([]);
  });

  it('applies a saved view on a sub-menu: the quick filter, the tree and the wide layout reach the URL and the rows request', async () => {
    await signIn('pm');
    await make({
      screen_key: 'site360-cw',
      name: 'CW B3 wide',
      filters: {
        region_id: '1',
        q: '',
        scenario: '',
        overall_status: '',
        site_codes: '',
        layout: 'wide',
        advanced: TREE,
      },
    });
    await make({
      screen_key: 'site360-cw',
      name: 'CW plain',
      filters: { layout: 'list' },
    });
    const seen = watchRows();
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?section=cw' });
    await screen.findByTestId('site-master-list');
    await waitFor(() => expect(options()).toContain('CW B3 wide'));
    await u.selectOptions(
      screen.getByTestId('views-select'),
      screen.getByRole('option', { name: 'CW B3 wide' }),
    );
    // wide = the wide table of the menu (layout=wide), with the same filters
    expect(await screen.findByTestId('sites-wide-table')).toBeInTheDocument();
    expect(
      await screen.findByTestId('filter-chip-x-region_id'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('filter-chip-0')).toHaveTextContent(
      'Delivery batch: B3',
    );
    await waitFor(() =>
      expect(
        seen.some(
          (s) =>
            s.startsWith('cw?') &&
            s.includes('region_id=1') &&
            s.includes('delivery_batch'),
        ),
      ).toBe(true),
    );
    // another view of the same menu brings the list back and drops the filters
    await u.selectOptions(
      screen.getByTestId('views-select'),
      screen.getByRole('option', { name: 'CW plain' }),
    );
    expect(await screen.findByTestId('site-master-list')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId('filter-chip-x-region_id')).toBeNull(),
    );
    expect(screen.queryByTestId('filter-chip-0')).toBeNull();
    expect(screen.queryByTestId('site-master-grid')).toBeNull();
  }, 30_000);

  it('the generic Site Master list keeps the views of its own screen', async () => {
    await signIn('pm');
    await make({ screen_key: 'site360-cw', name: 'Only for CW', filters: {} });
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('sites-list');
    expect(screen.getByTestId('saved-views')).toHaveAttribute(
      'data-screen',
      'sites',
    );
    expect(options()).not.toContain('Only for CW');
  });
});

describe('saved views of the dashboard', () => {
  const page = () =>
    renderApp(
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>,
      { route: '/dashboard' },
    );

  it('saves the quick parameters and the tree under the dashboard screen and applies them again', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    await screen.findByTestId('dash-progress-value');
    expect(screen.getByTestId('saved-views')).toHaveAttribute(
      'data-screen',
      'dashboard',
    );
    await u.click(await screen.findByTestId('filter-add'));
    await u.click(await screen.findByTestId('filter-field-region_id'));
    await u.click(await screen.findByTestId('filter-value-opt-5'));
    expect(await screen.findByTestId('filter-chip-0')).toHaveTextContent(
      'Region: Benghazi',
    );
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'Benghazi');
    await u.click(screen.getByTestId('views-name-ok'));
    await waitFor(() => expect(options()).toContain('Benghazi'));
    const saved = await api.get<{ items: SavedView[] }>('/saved-views', {
      query: { screen_key: 'dashboard' },
    });
    expect(saved.items[0]!.filters).toMatchObject({
      advanced: {
        op: 'and',
        items: [{ field: 'region_id', operator: 'in', value: ['5'] }],
      },
    });

    await u.click(screen.getByTestId('dash-reset'));
    await waitFor(() =>
      expect(screen.queryByTestId('filter-chips')).toBeNull(),
    );
    await u.selectOptions(
      screen.getByTestId('views-select'),
      screen.getByRole('option', { name: 'Benghazi' }),
    );
    expect(await screen.findByTestId('filter-chip-0')).toHaveTextContent(
      'Region: Benghazi',
    );
  }, 30_000);
});

describe('server-side search of a truncated value list', () => {
  const FIELD = {
    key: 'sub_region',
    label_en: 'Sub-region',
    label_ar: 'المنطقة الفرعية',
    type: 'enum',
    truncated: true,
    group: { key: 'site', label_en: 'Site', label_ar: 'الموقع' },
    operators: ['is', 'is_not', 'in', 'not_in', 'empty', 'not_empty'],
    options: [
      { value: 'AAA-1', label_en: 'AAA-1' },
      { value: 'AAA-2', label_en: 'AAA-2' },
    ],
  };

  it('asks the server as the user types (one debounced request), lists what it finds and applies a value that was not in the first list', async () => {
    await signIn('pm');
    server.use(
      http.get(`${API_BASE}/saved-views/filter-fields`, () =>
        HttpResponse.json({
          screen_key: 'sites',
          items: [FIELD],
          operators: { enum: FIELD.operators },
          limits: {
            max_depth: 2,
            max_items_per_group: 20,
            max_groups: 10,
            max_conditions: 50,
            max_values: 100,
          },
        }),
      ),
    );
    const asked: { field: string; q: string; screen: string; limit: string }[] =
      [];
    server.use(
      http.get(
        `${API_BASE}/saved-views/filter-fields/:field/values`,
        ({ request, params }) => {
          const u = new URL(request.url);
          asked.push({
            field: decodeURIComponent(String(params.field)),
            q: u.searchParams.get('q') ?? '',
            screen: u.searchParams.get('screen_key') ?? '',
            limit: u.searchParams.get('limit') ?? '',
          });
          return HttpResponse.json({
            screen_key: 'sites',
            field: 'sub_region',
            q: u.searchParams.get('q'),
            truncated: false,
            items: [{ value: 'ZETA-9', label_en: 'ZETA-9 (far)' }],
          });
        },
      ),
    );
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await u.click(await screen.findByTestId('filter-add'));
    await u.click(await screen.findByTestId('filter-field-sub_region'));
    expect(
      await screen.findByTestId('filter-value-truncated'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('filter-value-opt-AAA-1')).toBeInTheDocument();
    expect(asked).toEqual([]); // nothing is asked while the search box is empty
    await u.type(screen.getByTestId('filter-value-search'), 'zeta');
    const found = await screen.findByTestId('filter-value-opt-ZETA-9');
    expect(found).toHaveTextContent('ZETA-9 (far)');
    expect(screen.queryByTestId('filter-value-opt-AAA-1')).toBeNull();
    expect(asked).toEqual([
      { field: 'sub_region', q: 'zeta', screen: 'sites', limit: '50' },
    ]); // four keystrokes, one request
    await u.click(found);
    expect(await screen.findByTestId('filter-chip-0')).toHaveTextContent(
      'ZETA-9',
    );
    // the chosen value stays on the list while the search changes
    await u.clear(screen.getByTestId('filter-value-search'));
    await u.type(screen.getByTestId('filter-value-search'), 'nothing');
    await waitFor(() => expect(asked.map((a) => a.q)).toContain('nothing'));
    expect(screen.getByTestId('filter-value-opt-ZETA-9')).toBeInTheDocument();
  }, 30_000);

  it('does not search on the server when the list is complete: it narrows the list it has', async () => {
    await signIn('pm');
    server.use(
      http.get(`${API_BASE}/saved-views/filter-fields`, () =>
        HttpResponse.json({
          screen_key: 'sites',
          items: [
            {
              ...FIELD,
              truncated: false,
              options: Array.from({ length: 8 }, (_, i) => ({
                value: `V${i}`,
                label_en: `Value ${i}`,
              })),
            },
          ],
          operators: { enum: FIELD.operators },
          limits: {
            max_depth: 2,
            max_items_per_group: 20,
            max_groups: 10,
            max_conditions: 50,
            max_values: 100,
          },
        }),
      ),
    );
    const asked: string[] = [];
    server.use(
      http.get(
        `${API_BASE}/saved-views/filter-fields/:field/values`,
        ({ request }) => {
          asked.push(request.url);
          return HttpResponse.json({ items: [], truncated: false });
        },
      ),
    );
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await u.click(await screen.findByTestId('filter-add'));
    await u.click(await screen.findByTestId('filter-field-sub_region'));
    await u.type(await screen.findByTestId('filter-value-search'), 'value 3');
    await waitFor(() =>
      expect(screen.queryByTestId('filter-value-opt-V1')).toBeNull(),
    );
    expect(screen.getByTestId('filter-value-opt-V3')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 450));
    expect(asked).toEqual([]);
  }, 30_000);
});
