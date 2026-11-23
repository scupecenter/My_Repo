import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { decodeFilter, type FilterTree } from '@/api/views';
import { server } from '@/mocks/server';
import { pickFilterField, renderApp, signIn } from '@/test/utils';
import { MyWork } from './MyWork';
import { RegisterPage } from './Register';
import { Sites } from './Sites';

/** The unified filter (owner request 2026-11-22) on every list screen, with the AND/OR builder reachable from it (EN and AR). */
type U = ReturnType<typeof userEvent.setup>;
/** Records the `filter` parameter of the GET requests of a path (the other handlers still answer). */
function watch(path: string, param = 'filter'): string[] {
  const seen: string[] = [];
  server.use(http.get(`${API_BASE}${path}`, ({ request }) => {
    const f = new URL(request.url).searchParams.get(param);
    if (f) seen.push(f);
  }));
  return seen;
}
const last = (seen: string[]): FilterTree | null => decodeFilter(seen[seen.length - 1]);
const tree = (t: FilterTree) => `adv=${encodeURIComponent(JSON.stringify(t))}`;

/** The advanced builder: opens it from the dropdown, adds a group on `field` (its first value) and applies. */
async function advancedGroup(u: U, field: string, index = 0) {
  await u.click(await screen.findByTestId('filter-add'));
  await u.click(screen.getByTestId('filter-advanced'));
  const dlg = await screen.findByTestId('filter-dialog');
  await u.click(within(dlg).getByTestId('filter-add-group'));
  await u.selectOptions(within(dlg).getByTestId(`filter-group-${index}-cond-0-field`), field);
  await u.click(within(dlg).getByTestId('filter-dialog-submit'));
}

describe('unified filter', () => {
  it('opens the dropdown, searches a field, picks Delivery batch, selects two values, shows the chip and sends the tree', async () => {
    await signIn('pm');
    const seen = watch('/sites');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('sites-list');
    expect(screen.queryByTestId('sites-filter-region')).toBeNull(); // the separate selects are gone
    await u.click(await screen.findByTestId('filter-add'));
    expect(await screen.findByTestId('filter-popover')).toBeInTheDocument();
    expect(screen.getByTestId('filter-group-site')).toBeInTheDocument();
    expect(screen.getByTestId('filter-group-work')).toBeInTheDocument();
    await u.type(screen.getByTestId('filter-search'), 'batch');
    expect(screen.queryByTestId('filter-field-region_id')).toBeNull();
    await u.click(screen.getByTestId('filter-field-delivery_batch'));
    await u.click(await screen.findByTestId('filter-value-opt-B3'));
    await u.click(screen.getByTestId('filter-value-opt-B4'));
    await waitFor(() => expect(last(seen)).toEqual({ op: 'and', items: [{ field: 'delivery_batch', operator: 'in', value: ['B3', 'B4'] }] }));
    expect(screen.getByTestId('filter-chip-0')).toHaveTextContent('Delivery batch: B3, B4');

    // the view keeps the tree; clearing all and choosing the view brings it back
    await u.click(screen.getByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'Batches 3 and 4');
    await u.click(screen.getByTestId('views-name-ok'));
    await waitFor(() => expect(within(screen.getByTestId('views-select')).getByRole('option', { name: 'Batches 3 and 4' })).toBeInTheDocument());
    await u.click(screen.getByTestId('filter-clear-all'));
    await waitFor(() => expect(screen.queryByTestId('filter-chips')).toBeNull());
    await u.selectOptions(screen.getByTestId('views-select'), screen.getByRole('option', { name: 'Batches 3 and 4' }));
    expect(await screen.findByTestId('filter-chip-0')).toHaveTextContent('Delivery batch: B3, B4');
  }, 30_000);

  it('date: between from and to, then edit the chip to "last N days"', async () => {
    await signIn('pm');
    const seen = watch('/sites');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('sites-list');
    await pickFilterField(u, 'rf_survey_date');
    expect(screen.getByTestId('filter-apply')).toBeDisabled(); // both dates are needed
    fireEvent.change(await screen.findByTestId('filter-date-from'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByTestId('filter-date-to'), { target: { value: '2026-01-31' } });
    await u.click(screen.getByTestId('filter-apply'));
    await waitFor(() => expect(last(seen)).toEqual({ op: 'and', items: [{ field: 'rf_survey_date', operator: 'between', value: ['2026-01-01', '2026-01-31'] }] }));
    expect(screen.getByTestId('filter-chip-0')).toHaveTextContent('RF survey date is between 2026-01-01 and 2026-01-31');
    // click the chip to edit it
    await u.click(screen.getByTestId('filter-chip-0-edit'));
    await u.click(await screen.findByTestId('filter-date-mode-last'));
    fireEvent.change(screen.getByTestId('filter-date-days'), { target: { value: '14' } });
    await u.click(screen.getByTestId('filter-apply'));
    await waitFor(() => expect(last(seen)).toEqual({ op: 'and', items: [{ field: 'rf_survey_date', operator: 'in_last_days', value: 14 }] }));
  }, 30_000);

  it('removes one chip, then clears all', async () => {
    await signIn('pm');
    const seen = watch('/sites');
    const u = userEvent.setup();
    const t: FilterTree = { op: 'and', items: [{ field: 'delivery_batch', operator: 'in', value: ['B3'] }, { field: 'region_id', operator: 'in', value: ['1'] }] };
    renderApp(<Sites />, { route: `/sites?layout=list&${tree(t)}` });
    expect(await screen.findByTestId('filter-chip-1')).toHaveTextContent('Region: Tripoli');
    await u.click(screen.getByTestId('filter-chip-remove-1'));
    await waitFor(() => expect(last(seen)).toEqual({ op: 'and', items: [{ field: 'delivery_batch', operator: 'in', value: ['B3'] }] }));
    expect(screen.queryByTestId('filter-chip-1')).toBeNull();
    await u.click(screen.getByTestId('filter-clear-all'));
    await waitFor(() => expect(screen.queryByTestId('filter-chips')).toBeNull());
  }, 30_000);

  it('"Assigned to me" is a field of the Work group and still sends the old bucket parameter', async () => {
    await signIn('pm');
    const buckets = watch('/sites', 'bucket');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('sites-list');
    await pickFilterField(u, 'mine');
    await u.click(await screen.findByTestId('filter-extra-on'));
    await waitFor(() => expect(buckets).toContain('mine'));
    expect(screen.getByTestId('filter-chip-x-mine')).toHaveTextContent('Assigned to me');
    await u.click(screen.getByTestId('filter-chip-remove-x-mine'));
    await waitFor(() => expect(screen.queryByTestId('filter-chip-x-mine')).toBeNull());
  }, 30_000);

  it('a Site Master sub-menu uses its own screen key and sends the tree to its rows', async () => {
    await signIn('pm');
    const seen = watch('/site360/:menu/rows');
    const screens: string[] = [];
    server.use(http.get(`${API_BASE}/saved-views/filter-fields`, ({ request }) => { screens.push(new URL(request.url).searchParams.get('screen_key') ?? ''); }));
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?section=cw' });
    await u.click(await screen.findByTestId('filter-add'));
    expect(screens).toContain('site360-cw');
    await u.type(screen.getByTestId('filter-search'), 'batch');
    await u.click(screen.getByTestId('filter-field-delivery_batch'));
    await u.click(await screen.findByTestId('filter-value-opt-B3'));
    await waitFor(() => expect(last(seen)).toEqual({ op: 'and', items: [{ field: 'delivery_batch', operator: 'in', value: ['B3'] }] }));
    expect(screen.getByTestId('filter-chip-0')).toHaveTextContent('Delivery batch: B3');
  }, 30_000);

  it('is keyboard operable: arrows move through the list and Enter opens the field; every control has a name', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('sites-list');
    (await screen.findByTestId('filter-add')).focus();
    await u.keyboard('{Enter}');
    const search = await screen.findByTestId('filter-search');
    expect(search).toHaveAccessibleName();
    expect(screen.getByTestId('filter-add')).toHaveAccessibleName();
    await u.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByTestId('filter-editor-title')).toHaveTextContent('Site name'); // the second field of the Site group
    await u.click(screen.getByTestId('filter-back'));
    expect(await screen.findByTestId('filter-search')).toBeInTheDocument();
  }, 30_000);

  it('Arabic (RTL): labels, groups, values and chips', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list', locale: 'ar' });
    await screen.findByTestId('sites-list');
    expect(document.documentElement.dir).toBe('rtl');
    const add = await screen.findByTestId('filter-add');
    expect(add).toHaveTextContent('فلتر');
    expect(add).toHaveAccessibleName('إضافة فلتر');
    await u.click(add);
    expect(await screen.findByRole('group', { name: 'الموقع' })).toBeInTheDocument();
    expect(screen.getByTestId('filter-field-delivery_batch')).toHaveTextContent('دفعة التسليم');
    expect(screen.getByTestId('filter-advanced')).toHaveTextContent('متقدم');
    await u.click(screen.getByTestId('filter-field-delivery_batch'));
    await u.click(await screen.findByTestId('filter-value-opt-B3'));
    expect(await screen.findByTestId('filter-chip-0')).toHaveTextContent('دفعة التسليم: B3');
    expect(screen.getByTestId('filter-clear-all')).toHaveTextContent('مسح الكل');
  }, 30_000);

  it('a register list: the unified filter sends the tree with the records query', async () => {
    await signIn('pm');
    const seen = watch('/registers/:key/records');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: '/registers/procurement' });
    await u.click(await screen.findByTestId('filter-add'));
    await u.click(await screen.findByTestId('filter-field-state'));
    await u.click(await screen.findByTestId('filter-value-opt-entry'));
    await u.click(screen.getByTestId('filter-value-opt-approved'));
    await waitFor(() => expect(last(seen)).toEqual({ op: 'and', items: [{ field: 'state', operator: 'in', value: ['entry', 'approved'] }] }));
    expect(screen.getByTestId('filter-chip-0')).toHaveTextContent('State: Entry, Approved');
  }, 30_000);
});

describe('advanced (AND / OR) beside the unified filter', () => {
  it('Site Master: a group combines with a simple chip into one tree', async () => {
    await signIn('pm');
    const seen = watch('/sites');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await screen.findByTestId('sites-list');
    await pickFilterField(u, 'delivery_batch');
    await u.click(await screen.findByTestId('filter-value-opt-B3'));
    await u.keyboard('{Escape}'); // the value step stays open (multi-select); "+ Filter" would toggle it shut
    await waitFor(() => expect(screen.queryByTestId('filter-popover')).toBeNull());
    await advancedGroup(u, 'overall_status', 1);
    await waitFor(() => expect(last(seen)).toEqual({ op: 'and', items: [
      { field: 'delivery_batch', operator: 'in', value: ['B3'] },
      { op: 'or', items: [{ field: 'overall_status', operator: 'is', value: 'not_started' }] },
    ] }));
    expect(await screen.findByTestId('filter-chip-1')).toHaveTextContent('( Overall status is Not started )');
  }, 30_000);

  it('Site Master sub-menu', async () => {
    await signIn('pm');
    const seen = watch('/site360/:menu/rows');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?section=te' });
    await advancedGroup(u, 'overall_status');
    await waitFor(() => expect(last(seen)).toEqual({ op: 'and', items: [{ op: 'or', items: [{ field: 'overall_status', operator: 'is', value: 'not_started' }] }] }));
  }, 30_000);

  it('a register', async () => {
    await signIn('pm');
    const seen = watch('/registers/:key/records');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: '/registers/procurement' });
    await advancedGroup(u, 'state');
    await waitFor(() => expect(last(seen)).toEqual({ op: 'and', items: [{ op: 'or', items: [{ field: 'state', operator: 'is', value: 'entry' }] }] }));
    expect(await screen.findByTestId('filter-chip-0')).toHaveTextContent('( State is Entry )');
  }, 30_000);

  it('My Work (the tasks board)', async () => {
    await signIn('pm');
    const seen = watch('/boards/tasks');
    const u = userEvent.setup();
    renderApp(<MyWork />, { route: '/my-work?layout=board' });
    await advancedGroup(u, 'state');
    await waitFor(() => expect(last(seen)).toEqual({ op: 'and', items: [{ op: 'or', items: [{ field: 'state', operator: 'is', value: 'open' }] }] }));
  }, 30_000);
});

describe('saved view sharing', () => {
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
});
