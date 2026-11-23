import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Sites } from './Sites';

const Where = () => { const l = useLocation(); return <span data-testid="where">{l.pathname}{l.search}</span>; };
const App = () => <><Routes><Route path="/sites" element={<Sites />} /><Route path="/sites/:id" element={<span data-testid="site-page" />} /></Routes><Where /></>;
const heads = () => screen.getAllByRole('columnheader').map((h) => h.textContent);

describe('Site Master wide table', () => {
  it('the toggle sets layout=wide, keeps the other params and the default stays the list', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/sites?region_id=1' });
    const btn = await screen.findByTestId('sites-layout-wide');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(await screen.findByTestId('sites-list')).toBeTruthy();
    expect(screen.queryByTestId('sites-wide')).toBeNull();
    await userEvent.click(btn);
    expect(await screen.findByTestId('sites-wide-table')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toContain('layout=wide');
    expect(screen.getByTestId('where').textContent).toContain('region_id=1');
    expect(screen.getByTestId('sites-layout-wide')).toHaveAttribute('aria-pressed', 'true');
  });

  it('Site Master: #, Site ID, Site Information, the last stage, all in Master order, LTR, two frozen columns, empty cells say Not entered', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/sites?layout=wide' });
    const table = await screen.findByTestId('sites-wide-table');
    await screen.findByTestId('wide-row-S360-001');
    expect(table).toHaveAttribute('dir', 'ltr');
    expect(table.getAttribute('data-menu')).toBe('master');
    const h = heads();
    expect(h.slice(0, 2)).toEqual(['#', 'Site ID']);
    expect(h).toEqual(expect.arrayContaining(['Site Name', 'Region', 'TE Access Date', 'Cluster ID', 'CW DLP Start Date', 'Remark']));
    expect(h.indexOf('Site Name')).toBeLessThan(h.indexOf('TE Access Date'));
    expect(h.indexOf('TE Access Date')).toBeLessThan(h.indexOf('CW DLP Start Date')); // O&M columns come last
    expect(screen.getAllByTestId('wide-group').length).toBeGreaterThan(3);
    expect(screen.getByTestId('wide-col-num').style.position).toBe('sticky');
    expect(screen.getByTestId('wide-col-site').style.position).toBe('sticky');
    const row = screen.getByTestId('wide-row-S360-001');
    expect(within(row).getAllByRole('cell')[0]).toHaveTextContent('1');
    expect(within(row).getAllByRole('cell')[0].style.position).toBe('sticky');
    expect(within(row).getAllByRole('cell')[1].style.position).toBe('sticky');
    expect(within(row).getByText('Synthetic site one')).toBeTruthy();
    expect(within(row).getAllByText('Not entered').length).toBeGreaterThan(0);
    expect(row.querySelector('input:not([type=checkbox])')).toBeNull(); // the only input of a row is its selection checkbox
  });

  it('a sub-menu shows #, the site and only its own columns; the open icon of the Site ID cell opens the site page', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/sites?section=cw&layout=wide' });
    await screen.findByTestId('wide-row-S360-001');
    expect(screen.getByTestId('sites-wide-table').getAttribute('data-menu')).toBe('cw');
    const h = heads();
    expect(h.slice(0, 2)).toEqual(['#', 'Site ID']);
    expect(h).toEqual(expect.arrayContaining(['Pre-CW Readiness', 'CW Delivery Model']));
    expect(h).not.toContain('TE Access Date');
    expect(h).not.toContain('Cluster ID');
    await userEvent.click(screen.getByTestId('wide-row-S360-002'));
    expect(screen.getByTestId('where').textContent).toContain('/sites?'); // a row click does not navigate
    await userEvent.click(screen.getByTestId('site-row-S360-002'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/sites/a0000000-0000-4000-8000-000000000002'));
  });

  it('has Arabic strings', async () => {
    await signIn('pm');
    renderApp(<App />, { route: '/sites?layout=wide', locale: 'ar' });
    await screen.findByTestId('wide-row-S360-001');
    const row = screen.getByTestId('wide-row-S360-001');
    expect(within(row).getAllByText(/غير مُدخل/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('sites-layout-wide')).toHaveTextContent(/[؀-ۿ]/);
    expect(screen.getByTestId('sites-wide-table')).toHaveAttribute('dir', 'ltr');
  });

  it('keeps the filters visible and sends the same URL filters as the sub-menu list to the rows endpoint', async () => {
    await signIn('pm');
    const urls: URL[] = [];
    server.use(http.get(`${API_BASE}/site360/:menu/rows`, ({ request }) => { urls.push(new URL(request.url)); return HttpResponse.json({ total: 0, filtered: 0, offset: 0, limit: 200, rows: [] }); }));
    renderApp(<App />, { route: '/sites?section=te&layout=wide&region_id=1&scenario=expansion&overall_status=in_progress&q=abc' });
    await screen.findByTestId('sites-wide-table');
    for (const id of ['sites-search', 'sites-filter-region', 'sites-filter-scenario', 'sites-filter-status']) expect(screen.getByTestId(id)).toBeTruthy();
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    const p = urls[0]!.searchParams;
    expect(urls[0]!.pathname).toContain('/site360/te/rows');
    expect([p.get('region_id'), p.get('scenario'), p.get('status')]).toEqual(['1', 'expansion', 'in_progress']);
  });

  describe('editing', () => {
    const rowsWithTargets = () => server.use(http.get(`${API_BASE}/site360/:menu/rows`, ({ request }) => {
      const values = { '4': 'Name', '5': 'Tripoli', '78': '2026-03-10', '33': 'outsourced' };
      return HttpResponse.json({ total: 2, filtered: 2, offset: 0, limit: 50, rows: [
        { site_id: 'a0000000-0000-4000-8000-000000000001', site_code: 'S360-001', row_no: 1, values, cells: { '78': { task_id: 'task-1', version: 3, editable: true, field: 'actual_date' }, '33': { task_id: 'task-1', version: 3, editable: false } } },
        { site_id: 'a0000000-0000-4000-8000-000000000002', site_code: 'S360-002', row_no: 2, values, cells: { '78': { task_id: 'task-2', version: 7, editable: true, field: 'actual_date' } } },
      ], url: request.url });
    }));
    const patched: { url: string; body: unknown; ifMatch: string | null }[] = [];
    const ok = () => server.use(http.patch(`${API_BASE}/tasks/:id`, async ({ request }) => { patched.push({ url: request.url, body: await request.json(), ifMatch: request.headers.get('If-Match') }); return HttpResponse.json({ id: 'task-1', version: 4 }); }));

    it('an editable cell saves through PATCH /tasks/{id} with the version, and only that site is touched', async () => {
      patched.length = 0;
      await signIn('pm'); rowsWithTargets(); ok();
      renderApp(<App />, { route: '/sites?section=te&layout=wide' });
      await userEvent.click(await screen.findByTestId('wide-edit-S360-001-78'));
      const input = screen.getByTestId('wide-input-S360-001-78');
      expect(input).toHaveAttribute('type', 'date');
      expect(screen.queryByTestId('wide-input-S360-002-78')).toBeNull();
      await userEvent.clear(input);
      await userEvent.type(input, '2026-04-01{Enter}');
      await waitFor(() => expect(patched).toHaveLength(1));
      expect(patched[0]!.url).toContain('/tasks/task-1');
      expect(patched[0]!.body).toEqual({ actual_date: '2026-04-01' });
      expect(patched[0]!.ifMatch).toContain('3');
      expect(screen.queryByTestId('wide-input-S360-001-78')).toBeNull();
    });

    it('Esc cancels without saving; a locked or computed cell has no editor and says why', async () => {
      patched.length = 0;
      await signIn('pm'); rowsWithTargets(); ok();
      renderApp(<App />, { route: '/sites?layout=wide' });
      await userEvent.click(await screen.findByTestId('wide-edit-S360-002-78'));
      await userEvent.type(screen.getByTestId('wide-input-S360-002-78'), '{Escape}');
      expect(screen.queryByTestId('wide-input-S360-002-78')).toBeNull();
      expect(patched).toHaveLength(0);
      expect(screen.queryByTestId('wide-edit-S360-001-33')).toBeNull(); // editable: false
      expect(screen.getByTestId('wide-cell-S360-001-33')).toHaveAttribute('title', expect.stringContaining('Read-only'));
    });

    it('a version conflict shows the existing message', async () => {
      await signIn('pm'); rowsWithTargets();
      server.use(http.patch(`${API_BASE}/tasks/:id`, () => HttpResponse.json({ type: 'about:blank', title: 'Precondition failed', status: 412, code: 'precondition_failed' }, { status: 412 })));
      renderApp(<App />, { route: '/sites?section=te&layout=wide' });
      await userEvent.click(await screen.findByTestId('wide-edit-S360-001-78'));
      await userEvent.clear(screen.getByTestId('wide-input-S360-001-78'));
      await userEvent.type(screen.getByTestId('wide-input-S360-001-78'), '2026-05-05');
      await userEvent.click(screen.getByTestId('wide-save-S360-001-78'));
      expect((await screen.findByTestId('wide-error-S360-001-78')).textContent).toMatch(/Someone changed this/);
      expect(screen.getByTestId('wide-input-S360-001-78')).toBeTruthy(); // the editor stays open with the draft
    });

    const typed = () => server.use(http.get(`${API_BASE}/site360/:menu/rows`, () => HttpResponse.json({ total: 1, filtered: 1, offset: 0, limit: 50, rows: [
      { site_id: 'a0000000-0000-4000-8000-000000000001', site_code: 'S360-001', row_no: 1, values: { '4': 'Name', '40': '12', '41': 'B', '42': 'true' }, cells: {
        '40': { task_id: 'task-1', version: 3, editable: true, values: 'height', input_type: 'number' },
        '41': { task_id: 'task-1', version: 3, editable: true, values: 'grade', input_type: 'list', options: [{ value: 'A', label_en: 'Grade A', label_ar: 'الدرجة أ' }, { value: 'B', label_en: 'Grade B', label_ar: null }] },
        '42': { task_id: 'task-1', version: 3, editable: true, values: 'fenced', input_type: 'boolean' },
      } },
    ] })));

    it('a number cell opens a number input and saves a JSON number through the same endpoint', async () => {
      patched.length = 0;
      await signIn('pm'); typed(); ok();
      renderApp(<App />, { route: '/sites?layout=wide' });
      await userEvent.click(await screen.findByTestId('wide-edit-S360-001-40'));
      const input = screen.getByTestId('wide-input-S360-001-40');
      expect(input).toHaveAttribute('type', 'number');
      await userEvent.clear(input);
      await userEvent.type(input, '15.5{Enter}');
      await waitFor(() => expect(patched).toHaveLength(1));
      expect(patched[0]!.url).toContain('/tasks/task-1');
      expect(patched[0]!.body).toEqual({ values: { height: 15.5 } });
      expect(patched[0]!.ifMatch).toContain('3');
    });

    it('a list cell shows its label, opens a select with the options and saves the chosen value', async () => {
      patched.length = 0;
      await signIn('pm'); typed(); ok();
      renderApp(<App />, { route: '/sites?layout=wide' });
      const btn = await screen.findByTestId('wide-edit-S360-001-41');
      expect(btn).toHaveTextContent('Grade B');
      await userEvent.click(btn);
      const sel = screen.getByTestId('wide-input-S360-001-41');
      expect(sel.tagName).toBe('SELECT');
      expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'Grade A', 'Grade B']);
      await userEvent.selectOptions(sel, 'A');
      await userEvent.click(screen.getByTestId('wide-save-S360-001-41'));
      await waitFor(() => expect(patched).toHaveLength(1));
      expect(patched[0]!.body).toEqual({ values: { grade: 'A' } });
    });

    it('a yes or no cell is a checkbox and saves a boolean', async () => {
      patched.length = 0;
      await signIn('pm'); typed(); ok();
      renderApp(<App />, { route: '/sites?layout=wide' });
      await userEvent.click(await screen.findByTestId('wide-edit-S360-001-42'));
      const box = screen.getByTestId('wide-input-S360-001-42');
      expect(box).toHaveAttribute('type', 'checkbox');
      expect(box).toBeChecked();
      await userEvent.click(box);
      await userEvent.click(screen.getByTestId('wide-save-S360-001-42'));
      await waitFor(() => expect(patched).toHaveLength(1));
      expect(patched[0]!.body).toEqual({ values: { fenced: false } });
    });

    it('a validation error of the API shows next to the cell and the editor stays open', async () => {
      await signIn('pm'); typed();
      server.use(http.patch(`${API_BASE}/tasks/:id`, () => HttpResponse.json({ type: 'about:blank', title: 'Validation failed', status: 422, code: 'validation_failed', errors: [{ path: '/values/height', code: 'out_of_range', message: 'The height is out of range.' }] }, { status: 422 })));
      renderApp(<App />, { route: '/sites?layout=wide' });
      await userEvent.click(await screen.findByTestId('wide-edit-S360-001-40'));
      await userEvent.clear(screen.getByTestId('wide-input-S360-001-40'));
      await userEvent.type(screen.getByTestId('wide-input-S360-001-40'), '999{Enter}');
      expect((await screen.findByTestId('wide-error-S360-001-40')).textContent).toMatch(/out of range/);
      expect(screen.getByTestId('wide-input-S360-001-40')).toBeTruthy();
    });
  });
});
