import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { API_BASE } from '@/api/client';
import { recId } from '@/mocks/registersData';
import { server } from '@/mocks/server';
import { siteMeta } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

// ECharts draws in the browser; here the chart is a placeholder with its text alternative.
vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

/**
 * W2 of plan 2026-11-23-next-ui-cleanup: the Site Master view options on the registers, per layout, on a register whose records carry a site with
 * coordinates (Procurement) and on one without (Meetings: global rows, no Map). Synthetic data of the mocks only.
 */
const Where = () => { const l = useLocation(); return <output data-testid="where">{l.search}</output>; };
const App = () => <><Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes><Where /></>;
const where = () => screen.getByTestId('where').textContent ?? '';
const T = 20_000;
const ENTRY = recId(3); // the Procurement WO of site 2, in entry: editable by its L1
const APPROVED = recId(1); // the Procurement PR of site 0, approved: read-only

/** The View menu (one button, a menu of layouts): open it, pick a layout by its old test id. */
async function pickView(u: ReturnType<typeof userEvent.setup>, prefix: string, id: string) {
  await u.click(screen.getByTestId(`${prefix}-view`));
  await u.click(await screen.findByTestId(`${prefix}-layout-${id}`));
}

describe('W2 Procurement (records with a site): the view switcher of Site Master', () => {
  it('the toolbar shows one View menu after the count and before New; its items are List, Wide table, Grid, Board and Map, and the list stays the default', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    const bar = screen.getByTestId('register-toolbar');
    const ids = [...bar.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'));
    const at = (id: string) => ids.indexOf(id);
    expect(at('register-count')).toBeGreaterThan(-1);
    expect(at('register-view')).toBeGreaterThan(at('register-count'));
    expect(at('register-new')).toBeGreaterThan(at('register-view'));
    expect(at('register-layout-wide')).toBe(-1); // the layouts live in the menu, not as buttons of the toolbar
    await userEvent.click(screen.getByTestId('register-view'));
    for (const b of ['list', 'wide', 'grid', 'board', 'map']) expect(await screen.findByTestId(`register-layout-${b}`)).toHaveAttribute('aria-checked', b === 'list' ? 'true' : 'false');
  }, T);

  it('wide table: one row per record, # and Site ID frozen, the form sections as header row 1, LTR in Arabic too', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/procurement', locale: 'ar' });
    await screen.findByTestId('register-list-card');
    await pickView(u, 'register', 'wide');
    const table = await screen.findByTestId('register-wide-table');
    expect(where()).toContain('layout=wide');
    expect(table).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('register-wide-scroll')).toHaveAttribute('dir', 'ltr');
    expect(table).toHaveAttribute('data-depth', '2');
    expect(screen.getByTestId('wide-col-num').style.position).toBe('sticky');
    expect(screen.getByTestId('wide-col-site').style.position).toBe('sticky');
    expect(screen.getByTestId('wide-col-num')).toHaveAttribute('rowspan', '2');
    // every field of the register, the ones the list hides by default too, under its section
    expect(screen.getByTestId('wide-col-f:scope')).toBeTruthy();
    expect(screen.getByTestId('wide-col-f:order_status')).toBeTruthy();
    expect(screen.getAllByTestId('wide-group').map((g) => g.textContent)).toEqual(expect.arrayContaining(['السجل', 'سير الاعتماد']));
    const row = await screen.findByTestId(`wide-row-${ENTRY}`);
    expect(within(row).getAllByRole('cell')[0]).toHaveTextContent(/\d/);
    expect(within(row).getAllByRole('cell')[1].style.position).toBe('sticky');
    // the count of the toolbar stays the server's
    expect(screen.getByTestId('register-count')).toHaveAttribute('data-total');
  }, T);

  it('wide table inline edit: only where the register allows it, through the record update (If-Match the version)', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const patches: { url: string; ifMatch: string | null }[] = [];
    server.events.on('request:start', ({ request }) => { if (request.method === 'PATCH') patches.push({ url: request.url, ifMatch: request.headers.get('If-Match') }); });
    renderApp(<App />, { route: '/registers/procurement?layout=wide' });
    await screen.findByTestId(`wide-row-${ENTRY}`);
    // an approved record is read-only: no editor, the reason in a tooltip
    const ro = screen.getByTestId(`wide-cell-${APPROVED}-f:po_wo_no`);
    expect(ro).not.toHaveAttribute('data-editable');
    expect(ro.getAttribute('title')).toMatch(/Approved/);
    expect(screen.queryByTestId(`wide-edit-${APPROVED}-f:po_wo_no`)).toBeNull();
    // the state and the ball in court belong to the workflow
    expect(screen.getByTestId(`wide-row-${ENTRY}`).querySelector('td[data-col="state"]')).not.toHaveAttribute('data-editable');
    // an entry record: the typed editor, Save, and the new value in the cell
    await u.click(screen.getByTestId(`wide-edit-${ENTRY}-f:po_wo_no`));
    const input = screen.getByTestId(`wide-input-${ENTRY}-f:po_wo_no`);
    expect(input).toHaveAttribute('data-input', 'text');
    await u.clear(input);
    await u.type(input, 'WO-W2-7');
    await u.click(screen.getByTestId(`wide-save-${ENTRY}-f:po_wo_no`));
    await waitFor(() => expect(screen.getByTestId(`wide-cell-${ENTRY}-f:po_wo_no`)).toHaveTextContent('WO-W2-7'));
    expect(screen.queryByTestId(`wide-input-${ENTRY}-f:po_wo_no`)).toBeNull();
    const p = patches.find((x) => x.url.includes(`/registers/procurement/records/${ENTRY}`));
    expect(p).toBeDefined();
    expect(p!.ifMatch).toBeTruthy();
    // undo (8 s): the same edit path puts the old value back
    const undo = await screen.findByTestId('toast-action');
    const before = patches.length;
    await u.click(undo);
    await waitFor(() => expect(patches.length).toBe(before + 1));
    await waitFor(() => expect(screen.getByTestId(`wide-cell-${ENTRY}-f:po_wo_no`)).not.toHaveTextContent('WO-W2-7'));
    // a list field with values offers them in a select
    await u.click(screen.getByTestId(`wide-edit-${ENTRY}-f:scope`));
    expect(screen.getByTestId(`wide-input-${ENTRY}-f:scope`)).toHaveAttribute('data-input', 'list');
    await u.keyboard('{Escape}');
  }, T);

  it('wide table batch edit: edits wait in a draft with a Pending chip, nothing is saved until Save all, then one PATCH per record', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const patches: string[] = [];
    const on = ({ request }: { request: Request }) => { if (request.method === 'PATCH') patches.push(request.url); };
    server.events.on('request:start', on);
    renderApp(<App />, { route: '/registers/procurement?layout=wide' });
    await screen.findByTestId(`wide-row-${ENTRY}`);
    await u.click(await screen.findByTestId('batch-start'));
    expect(screen.getByTestId('batch-count')).toHaveTextContent('0');
    await u.click(screen.getByTestId(`wide-edit-${ENTRY}-f:po_wo_no`));
    const input = screen.getByTestId(`wide-input-${ENTRY}-f:po_wo_no`);
    await u.clear(input);
    await u.type(input, 'WO-BATCH-1');
    await u.click(screen.getByTestId(`wide-save-${ENTRY}-f:po_wo_no`));
    expect(await screen.findByTestId(`wide-pending-${ENTRY}-po_wo_no`)).toHaveTextContent('WO-BATCH-1');
    expect(screen.getByTestId('batch-count')).toHaveTextContent('1 changes');
    expect(patches).toHaveLength(0);
    await u.click(screen.getByTestId('batch-review'));
    expect(screen.getByTestId('batch-review-list')).toHaveTextContent('WO-BATCH-1');
    await u.click(screen.getByTestId('batch-save'));
    await waitFor(() => expect(patches).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('batch-count')).toHaveTextContent('0 changes'));
    server.events.removeListener('request:start', on);
  }, T);

  it('wide table: a refused save keeps the editor open and says why', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    server.use(http.patch(`${API_BASE}/registers/procurement/records/:id`, () => new Response(JSON.stringify({ type: 'about:blank', title: 'Conflict', status: 412, code: 'version_conflict' }), { status: 412, headers: { 'Content-Type': 'application/problem+json' } })));
    renderApp(<App />, { route: '/registers/procurement?layout=wide' });
    await u.click(await screen.findByTestId(`wide-edit-${ENTRY}-f:po_wo_no`));
    await u.type(screen.getByTestId(`wide-input-${ENTRY}-f:po_wo_no`), '-X');
    await u.click(screen.getByTestId(`wide-save-${ENTRY}-f:po_wo_no`));
    expect(await screen.findByTestId(`wide-error-${ENTRY}-f:po_wo_no`)).toBeTruthy();
    expect(screen.getByTestId(`wide-input-${ENTRY}-f:po_wo_no`)).toBeTruthy();
  }, T);

  it('board: columns by the register status field (Order Status), the approval state on demand, swimlanes by region, a card opens the record', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await pickView(u, 'register', 'board');
    const board = await screen.findByTestId('register-board');
    expect(where()).toContain('layout=board');
    expect(board).toHaveAttribute('data-by', 'order_status');
    await screen.findByTestId('board-col-Open');
    expect(screen.getByTestId('board-col-Issued')).toBeTruthy();
    // every record of the filters sits in one column: the column counts add up to the server's filtered count
    const filtered = Number(screen.getByTestId('register-count').getAttribute('data-filtered'));
    await waitFor(() => {
      const sum = screen.getAllByTestId(/^board-col-count-/).reduce((n, e) => n + Number(e.textContent), 0);
      expect(sum).toBe(filtered);
    });
    await u.selectOptions(screen.getByTestId('register-board-by'), 'state');
    expect(where()).toContain('board_by=state');
    expect(await screen.findByTestId('board-col-entry')).toBeTruthy();
    expect(screen.getByTestId('board-col-approved')).toBeTruthy();
    expect(within(screen.getByTestId('board-col-approved')).getByTestId('board-col-count-approved').textContent).not.toBe('0');
    await u.selectOptions(screen.getByTestId('register-board-lane'), 'region');
    expect(where()).toContain('lane=region');
    expect(screen.getAllByTestId(/^board-lane-title-/).length).toBeGreaterThan(0);
    await u.click(screen.getByTestId(`board-record-${ENTRY}`));
    expect(where()).toContain(`record=${ENTRY}`);
  }, T);

  it('map: the Site Master map narrowed to the sites of the records', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await pickView(u, 'register', 'map');
    expect(where()).toContain('layout=map');
    const wrap = await screen.findByTestId('register-map-wrap');
    await screen.findByTestId('register-map');
    const sites = Number(wrap.getAttribute('data-sites'));
    expect(sites).toBeGreaterThan(0);
    await u.click(await screen.findByTestId('map-layout'));
    await screen.findByTestId('map-list');
    expect(screen.getByTestId(`map-row-${siteMeta(0).code}`)).toBeTruthy();
    expect(screen.queryByTestId(`map-row-${siteMeta(30).code}`)).toBeNull();
  }, T);

  it('a saved view keeps the layout, the board grouping and the swimlane', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/procurement?layout=board&board_by=state&lane=region' });
    await screen.findByTestId('register-board');
    await u.click(await screen.findByTestId('views-save'));
    await u.type(screen.getByTestId('views-name'), 'W2 board by region');
    await u.click(screen.getByTestId('views-name-ok'));
    await waitFor(() => expect(within(screen.getByTestId('views-select')).getAllByRole('option').map((o) => o.textContent)).toContain('W2 board by region'));
    await pickView(u, 'register', 'list'); // back to the list
    await screen.findByTestId('register-list-card');
    expect(where()).not.toContain('layout=');
    const opt = within(screen.getByTestId('views-select')).getAllByRole('option').find((o) => o.textContent === 'W2 board by region') as HTMLOptionElement;
    await u.selectOptions(screen.getByTestId('views-select'), opt.value);
    await screen.findByTestId('register-board');
    expect(where()).toContain('layout=board');
    expect(where()).toContain('board_by=state');
    expect(where()).toContain('lane=region');
  }, T);
});

describe('W2 Meetings (global rows, no site coordinates): no Map, the board falls back to the approval state', () => {
  it('offers Board and Wide table but no Map; a map link opens the list', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/registers/meetings?layout=map' });
    await screen.findByTestId('register-list-card');
    await userEvent.click(screen.getByTestId('register-view'));
    expect(await screen.findByTestId('register-layout-board')).toBeTruthy();
    expect(screen.getByTestId('register-layout-wide')).toBeTruthy();
    expect(screen.queryByTestId('register-layout-map')).toBeNull();
    expect(screen.queryByTestId('register-map')).toBeNull();
  }, T);

  it('wide table: the record column instead of Site ID, the global row with no site', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/registers/meetings' });
    await screen.findByTestId('register-list-card');
    await pickView(u, 'register', 'wide');
    await screen.findByTestId('register-wide-table');
    expect(screen.getByTestId('wide-col-site')).toHaveTextContent('Record');
    expect(screen.getByTestId('wide-col-f:title')).toBeTruthy();
    const row = await screen.findByTestId(`wide-row-${recId(15)}`);
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent('-');
    // the open button of the frozen cell opens the record
    await u.click(screen.getByTestId(`reg-wide-open-${recId(15)}`));
    expect(where()).toContain(`record=${recId(15)}`);
  }, T);

  it('board: no status field, so the columns are the approval states', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/registers/meetings?layout=board' });
    const board = await screen.findByTestId('register-board');
    expect(board).toHaveAttribute('data-by', 'state');
    expect(within(screen.getByTestId('register-board-by')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['state']);
    await waitFor(() => expect(screen.getByTestId('board-col-count-entry').textContent).toBe('1'));
    expect(screen.getByTestId(`board-record-${recId(15)}`)).toBeTruthy();
    // no record type on Meetings: the swimlanes are none and region
    expect(within(screen.getByTestId('register-board-lane')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['none', 'region']);
  }, T);

  it('remembers the picked view per user on the server and opens it next time; a link with a layout wins', async () => {
    const saved: Record<string, unknown>[] = [];
    let stored: { version: number; payload: Record<string, unknown> } | null = null;
    server.use(
      http.get(`${API_BASE}/me/drafts/:key`, ({ params }) => String(params.key) === 'form.viewpref.register-procurement' && stored
        ? Response.json({ key: String(params.key), version: stored.version, saved_at: new Date().toISOString(), created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString(), payload: stored.payload })
        : Response.json({ code: 'not_found', status: 404, title: 'none' }, { status: 404 })),
      http.put(`${API_BASE}/me/drafts/:key`, async ({ params, request }) => {
        const b = await request.json() as { payload: Record<string, unknown> };
        saved.push({ key: String(params.key), ...b.payload });
        stored = { version: (stored?.version ?? 0) + 1, payload: b.payload };
        return Response.json({ key: String(params.key), version: stored.version, saved_at: new Date().toISOString(), created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString() });
      }),
    );
    await signIn('pm');
    const u = userEvent.setup();
    const first = renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await pickView(u, 'register', 'board');
    await waitFor(() => expect(saved).toEqual([{ key: 'form.viewpref.register-procurement', layout: 'board' }]));
    first.unmount();
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-board');
    expect(where()).toContain('layout=board');
  }, T);
});
