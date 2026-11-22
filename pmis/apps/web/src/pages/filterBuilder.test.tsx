import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { decodeFilter } from '@/api/views';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';
import { Sites } from './Sites';

/** F3 (contract 0.15.31): the AND/OR filter builder inside saved views (EN and AR), sent to the server as a tree it compiles. */
function sitesFilters(): string[] {
  const seen: string[] = [];
  server.use(http.get(`${API_BASE}/sites`, ({ request }) => {
    const f = new URL(request.url).searchParams.get('filter');
    if (f) seen.push(f);
    // fall through to the mock list
  }));
  return seen;
}

describe('filter builder (F3)', () => {
  it('builds AND with an OR group, applies it as one filter parameter, shows chips and keeps it in a saved view', async () => {
    await signIn('pm');
    const seen = sitesFilters();
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('sites-list');
    await u.click(await screen.findByTestId('filter-builder-open'));
    const dlg = await screen.findByTestId('filter-dialog');
    expect(within(dlg).getByTestId('filter-empty')).toBeInTheDocument();
    await u.click(within(dlg).getByTestId('filter-add-condition'));
    await u.selectOptions(within(dlg).getByTestId('filter-cond-0-field'), 'region_id');
    await u.selectOptions(within(dlg).getByTestId('filter-cond-0-value'), '1');
    await u.click(within(dlg).getByTestId('filter-add-group'));
    await u.selectOptions(within(dlg).getByTestId('filter-group-1-cond-0-field'), 'delivery_scenario');
    await u.selectOptions(within(dlg).getByTestId('filter-group-1-cond-0-value'), 'expansion');
    await u.click(within(dlg).getByTestId('filter-group-1-add'));
    await u.selectOptions(within(dlg).getByTestId('filter-group-1-cond-1-field'), 'tower_height_m');
    await u.selectOptions(within(dlg).getByTestId('filter-group-1-cond-1-operator'), 'gte');
    await u.clear(within(dlg).getByTestId('filter-group-1-cond-1-value'));
    await u.type(within(dlg).getByTestId('filter-group-1-cond-1-value'), '40');
    // the group combines with OR (the opposite of the root by default); a third level is not offered
    expect(within(dlg).getByTestId('filter-group-1-op-or')).toHaveAttribute('aria-checked', 'true');
    expect(within(within(dlg).getByTestId('filter-group-1')).queryByTestId(/add-group/)).toBeNull();
    await u.click(within(dlg).getByTestId('filter-dialog-submit'));

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(JSON.parse(seen[seen.length - 1]!)).toEqual({
      op: 'and',
      items: [
        { field: 'region_id', operator: 'is', value: '1' },
        { op: 'or', items: [{ field: 'delivery_scenario', operator: 'is', value: 'expansion' }, { field: 'tower_height_m', operator: 'gte', value: 40 }] },
      ],
    });
    const chips = await screen.findByTestId('filter-chips');
    expect(within(chips).getByTestId('filter-chip-0')).toHaveTextContent('Region is Tripoli');
    expect(within(chips).getByTestId('filter-chip-1')).toHaveTextContent('( Delivery scenario is Expansion OR Tower height (m) ≥ 40 )');
    expect(screen.getByTestId('filter-builder-open')).toHaveTextContent('Filters (3)');

    // the view keeps the tree; applying the default view clears it, choosing the view brings it back
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'Tripoli or tall');
    await u.click(screen.getByTestId('views-name-ok'));
    await waitFor(() => expect(within(screen.getByTestId('views-select')).getByRole('option', { name: 'Tripoli or tall' })).toBeInTheDocument());
    await u.selectOptions(screen.getByTestId('views-select'), '');
    await waitFor(() => expect(screen.queryByTestId('filter-chips')).toBeNull());
    await u.selectOptions(screen.getByTestId('views-select'), screen.getByRole('option', { name: 'Tripoli or tall' }));
    expect(await screen.findByTestId('filter-chip-1')).toBeInTheDocument();
    // removing a chip removes that part only
    await u.click(screen.getByTestId('filter-chip-remove-1'));
    await waitFor(() => expect(decodeFilter(seen[seen.length - 1])).toEqual({ op: 'and', items: [{ field: 'region_id', operator: 'is', value: '1' }] }));
  }, 30_000);

  it('is keyboard operable: the AND/OR toggle moves with the arrow keys and every control has a name', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('sites-list');
    (await screen.findByTestId('filter-builder-open')).focus();
    await u.keyboard('{Enter}');
    const dlg = await screen.findByTestId('filter-dialog');
    const and = within(dlg).getByTestId('filter-root-op-and');
    and.focus();
    await u.keyboard('{ArrowRight}');
    expect(within(dlg).getByTestId('filter-root-op-or')).toHaveAttribute('aria-checked', 'true');
    await u.click(within(dlg).getByTestId('filter-add-condition'));
    for (const el of within(dlg).getAllByRole('combobox')) expect(el).toHaveAccessibleName();
    await u.selectOptions(within(dlg).getByTestId('filter-cond-0-field'), 'rf_survey_date');
    await u.selectOptions(within(dlg).getByTestId('filter-cond-0-operator'), 'in_last_days');
    expect(within(dlg).getByTestId('filter-cond-0-value')).toHaveAccessibleName('Number of days');
    await u.click(within(dlg).getByTestId('filter-cond-0-remove'));
    expect(within(dlg).getByTestId('filter-empty')).toBeInTheDocument();
  }, 30_000);

  it('Arabic (RTL): labels, operators and chips', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list', locale: 'ar' });
    await screen.findByTestId('sites-list');
    expect(document.documentElement.dir).toBe('rtl');
    const open = await screen.findByTestId('filter-builder-open');
    expect(open).toHaveTextContent('منشئ الفلاتر');
    await u.click(open);
    const dlg = await screen.findByTestId('filter-dialog');
    expect(within(dlg).getByRole('heading', { name: 'منشئ الفلاتر' })).toBeInTheDocument();
    await u.click(within(dlg).getByTestId('filter-add-condition'));
    await u.selectOptions(within(dlg).getByTestId('filter-cond-0-field'), 'region_id');
    expect(within(within(dlg).getByTestId('filter-cond-0-field')).getByRole('option', { name: 'المنطقة' })).toBeInTheDocument();
    await u.selectOptions(within(dlg).getByTestId('filter-cond-0-operator'), 'not_empty');
    expect(within(dlg).getByTestId('filter-root-op-and')).toHaveTextContent('و');
    await u.click(within(dlg).getByTestId('filter-dialog-submit'));
    expect(await screen.findByTestId('filter-chip-0')).toHaveTextContent('المنطقة غير فارغ');
  }, 30_000);

  it('the share dialog offers regions and sends region_ids', async () => {
    await signIn('pm');
    const bodies: unknown[] = [];
    server.use(http.patch(`${API_BASE}/saved-views/:id`, async ({ request }) => { bodies.push(await request.clone().json()); }));
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('sites-list');
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'By region');
    await u.click(screen.getByTestId('views-name-ok'));
    await waitFor(() => expect(within(screen.getByTestId('views-select')).getByRole('option', { name: 'By region' })).toBeInTheDocument());
    await u.selectOptions(screen.getByTestId('views-select'), screen.getByRole('option', { name: 'By region' }));
    await u.click(screen.getByTestId('views-share'));
    const dlg = await screen.findByTestId('views-share-dialog');
    await u.click(await within(dlg).findByTestId('views-share-region-4'));
    await u.click(within(dlg).getByTestId('views-share-region-1'));
    await u.click(within(dlg).getByTestId('views-share-dialog-submit'));
    await waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0]).toMatchObject({ audience: { region_ids: [1, 4] } });
    await waitFor(() => expect(within(screen.getByTestId('views-select')).getByRole('option', { name: /By region · shared/ })).toBeInTheDocument());
  }, 30_000);

  it('a register list offers the builder with its own whitelist and sends the tree with the records query', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.use(http.get(`${API_BASE}/registers/:key/records`, ({ request }) => { const f = new URL(request.url).searchParams.get('filter'); if (f) seen.push(f); }));
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: '/registers/procurement' });
    await u.click(await screen.findByTestId('filter-builder-open'));
    const dlg = await screen.findByTestId('filter-dialog');
    await u.click(within(dlg).getByTestId('filter-add-condition'));
    await u.selectOptions(within(dlg).getByTestId('filter-cond-0-field'), 'state');
    await u.selectOptions(within(dlg).getByTestId('filter-cond-0-operator'), 'in');
    await u.selectOptions(within(dlg).getByTestId('filter-cond-0-value'), ['entry', 'approved']);
    await u.click(within(dlg).getByTestId('filter-dialog-submit'));
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(JSON.parse(seen[seen.length - 1]!)).toEqual({ op: 'and', items: [{ field: 'state', operator: 'in', value: ['entry', 'approved'] }] });
    expect(await screen.findByTestId('filter-chip-0')).toHaveTextContent('State is any of Entry, Approved');
  }, 30_000);
});
