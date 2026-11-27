import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Sites } from './Sites';

const App = () => <Routes><Route path="/sites" element={<Sites />} /></Routes>;

/** Records every PATCH /tasks/{id} and lets the request fall through to the synthetic wide-table tasks of the mock. */
const record = () => {
  const seen: { id: string; body: unknown; ifMatch: string | null }[] = [];
  server.use(http.patch(`${API_BASE}/tasks/:id`, async ({ params, request }) => { seen.push({ id: String(params.id), body: await request.clone().json(), ifMatch: request.headers.get('If-Match') }); return undefined; }));
  return seen;
};
const pick = async (...codes: string[]) => { for (const c of codes) await userEvent.click(await screen.findByTestId(`wide-select-${c}`)); };

describe('Site Master wide table: bulk edit', () => {
  it('selects rows, previews N change and M skipped, saves each eligible cell with its own version and shows the summary', async () => {
    await signIn('pm');
    const seen = record();
    renderApp(<App />, { route: '/sites?section=te&layout=wide' });
    await userEvent.click(await screen.findByTestId('wide-select-all'));
    expect(await screen.findByTestId('sites-bulk-count')).toHaveTextContent('3');
    await userEvent.click(screen.getByTestId('sites-bulk-edit'));
    const dlg = await screen.findByTestId('bulk-edit');
    await userEvent.selectOptions(within(dlg).getByTestId('bulk-edit-field'), '78');
    const input = within(dlg).getByTestId('bulk-edit-value');
    expect(input).toHaveAttribute('placeholder', 'YYYY-MM-DD'); // the shared date field
    await userEvent.type(input, '2026-05-01');
    expect(within(dlg).getByTestId('bulk-edit-preview')).toHaveTextContent('2 sites will change, 1 skipped');
    expect(within(dlg).getByTestId('bulk-edit-skip-locked')).toBeTruthy();
    await userEvent.click(within(dlg).getByTestId('bulk-edit-confirm'));
    expect(await within(dlg).findByTestId('bulk-edit-result')).toBeTruthy();
    expect(within(dlg).getByTestId('bulk-edit-saved')).toHaveTextContent('Saved: 2');
    expect(within(dlg).getByTestId('bulk-edit-skipped')).toHaveTextContent('Skipped: 1');
    expect(within(dlg).getByTestId('bulk-edit-failed')).toHaveTextContent('Failed: 0');
    expect(seen.map((x) => x.id).sort()).toEqual(['wide-task-78-1', 'wide-task-78-2']);
    expect(seen.every((x) => JSON.stringify(x.body) === JSON.stringify({ actual_date: '2026-05-01' }))).toBe(true);
    expect(seen.every((x) => x.ifMatch?.includes('1'))).toBe(true);
    await userEvent.click(within(dlg).getByTestId('bulk-edit-close'));
    expect(screen.queryByTestId('bulk-edit')).toBeNull();
    expect(screen.queryByTestId('sites-bulk')).toBeNull(); // everything was saved: nothing stays selected
    // the affected rows were read again: the new version is in the next edit
    await userEvent.click(await screen.findByTestId('wide-edit-S360-001-78'));
    expect((screen.getByTestId('wide-input-S360-001-78') as HTMLInputElement).value).toBe('2026-05-01');
  });

  it('a site the caller may not edit is reported as failed with its reason, the others are saved, and only the failed one stays selected', async () => {
    await signIn('pm');
    server.use(http.patch(`${API_BASE}/tasks/:id`, ({ params }) => (params.id === 'wide-task-33-2' ? HttpResponse.json({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden' }, { status: 403 }) : undefined)));
    renderApp(<App />, { route: '/sites?section=cw&layout=wide' });
    await pick('S360-001', 'S360-002');
    await userEvent.click(screen.getByTestId('sites-bulk-edit'));
    const dlg = await screen.findByTestId('bulk-edit');
    await userEvent.selectOptions(within(dlg).getByTestId('bulk-edit-field'), '33');
    const sel = within(dlg).getByTestId('bulk-edit-value');
    expect(sel.tagName).toBe('SELECT');
    // S360-001 is outsourced and S360-002 internal: choosing "internal" changes only the first
    await userEvent.selectOptions(sel, 'internal');
    expect(within(dlg).getByTestId('bulk-edit-preview')).toHaveTextContent('1 sites will change, 1 skipped');
    expect(within(dlg).getByTestId('bulk-edit-skip-unchanged')).toBeTruthy();
    await userEvent.selectOptions(sel, 'outsourced');
    expect(within(dlg).getByTestId('bulk-edit-preview')).toHaveTextContent('1 sites will change, 1 skipped'); // now S360-002
    await userEvent.click(within(dlg).getByTestId('bulk-edit-confirm'));
    const failures = await within(dlg).findByTestId('bulk-edit-failures');
    expect(within(dlg).getByTestId('bulk-edit-saved')).toHaveTextContent('Saved: 0');
    expect(within(dlg).getByTestId('bulk-edit-failed')).toHaveTextContent('Failed: 1');
    expect(failures).toHaveTextContent('S360-002');
    expect(failures).toHaveTextContent(/no right/i);
    await userEvent.click(within(dlg).getByTestId('bulk-edit-close'));
    expect(screen.getByTestId('sites-bulk-count')).toHaveTextContent('1');
    expect((screen.getByTestId('wide-select-S360-002') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('wide-select-S360-001') as HTMLInputElement).checked).toBe(false);
  });

  it('cancel changes nothing and keeps the selection; with no editable cell the dialog says so', async () => {
    await signIn('pm');
    const seen = record();
    renderApp(<App />, { route: '/sites?section=te&layout=wide' });
    await pick('S360-001');
    await userEvent.click(screen.getByTestId('sites-bulk-edit'));
    await userEvent.click(await screen.findByTestId('bulk-edit-cancel'));
    expect(screen.queryByTestId('bulk-edit')).toBeNull();
    expect(screen.getByTestId('sites-bulk-count')).toHaveTextContent('1');
    expect(seen).toHaveLength(0);
  });

  it('with no editable cell in the menu the dialog says so and cannot confirm', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/site-master/:menu/rows`, () => HttpResponse.json({ total: 1, filtered: 1, offset: 0, limit: 50, rows: [{ site_id: 'a0000000-0000-4000-8000-000000000001', site_code: 'S360-001', row_no: 1, values: { '4': 'Name' }, cells: {} }] })));
    renderApp(<App />, { route: '/sites?section=sow&layout=wide' });
    await userEvent.click(await screen.findByTestId('wide-select-S360-001'));
    await userEvent.click(screen.getByTestId('sites-bulk-edit'));
    expect(await screen.findByTestId('bulk-edit-none')).toBeTruthy();
    expect((screen.getByTestId('bulk-edit-confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Site Master wide table: dependent lists', () => {
  const rows = () => server.use(http.get(`${API_BASE}/site-master/:menu/rows`, () => HttpResponse.json({ total: 3, filtered: 3, offset: 0, limit: 50, rows: [
    ['S360-001', 'WEST'], ['S360-002', 'EAST'], ['S360-003', null],
  ].map(([code, parent], i) => ({ site_id: `a0000000-0000-4000-8000-00000000000${i + 1}`, site_code: code, row_no: i + 1, values: { '4': 'Name', '24': parent, '33': null }, cells: {
    '24': { task_id: `p${i}`, version: 1, editable: true, values: 'region', input_type: 'list', options: [{ value: 'WEST', label_en: 'West', label_ar: null }, { value: 'EAST', label_en: 'East', label_ar: null }] },
    '33': { task_id: `c${i}`, version: 1, editable: true, values: 'city', input_type: 'list', parent_ord: 24, options: [
      { value: 'TIP', label_en: 'Tripoli', label_ar: null, parent: 'WEST' }, { value: 'MSR', label_en: 'Misrata', label_ar: null, parent: 'WEST' }, { value: 'BNG', label_en: 'Benghazi', label_ar: null, parent: 'EAST' }] },
  } })) })));

  it('the editor offers only the children of the parent value of the same row, and asks for the parent first when there is none', async () => {
    await signIn('pm'); rows();
    renderApp(<App />, { route: '/sites?layout=wide' });
    await userEvent.click(await screen.findByTestId('wide-edit-S360-001-33'));
    expect(within(screen.getByTestId('wide-input-S360-001-33')).getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'Tripoli', 'Misrata']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('wide-edit-S360-002-33'));
    expect(within(screen.getByTestId('wide-input-S360-002-33')).getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'Benghazi']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('wide-edit-S360-003-33'));
    expect(within(screen.getByTestId('wide-input-S360-003-33')).getAllByRole('option').map((o) => o.textContent)).toEqual(['None']);
    expect(screen.getByTestId('wide-parent-hint-S360-003-33')).toBeTruthy();
  });

  it('a bulk edit skips the sites whose parent value does not offer the chosen child', async () => {
    await signIn('pm'); rows();
    const seen = record();
    server.use(http.patch(`${API_BASE}/tasks/:id`, () => HttpResponse.json({ id: 'x', version: 2 })));
    renderApp(<App />, { route: '/sites?layout=wide' });
    await userEvent.click(await screen.findByTestId('wide-select-all'));
    await userEvent.click(screen.getByTestId('sites-bulk-edit'));
    const dlg = await screen.findByTestId('bulk-edit');
    await userEvent.selectOptions(within(dlg).getByTestId('bulk-edit-field'), '33');
    expect(within(dlg).getByTestId('bulk-edit-parent-hint')).toBeTruthy();
    await userEvent.selectOptions(within(dlg).getByTestId('bulk-edit-value'), 'TIP');
    expect(within(dlg).getByTestId('bulk-edit-preview')).toHaveTextContent('1 sites will change, 2 skipped');
    expect(within(dlg).getByTestId('bulk-edit-skip-not_allowed')).toHaveTextContent('2');
    expect(seen).toHaveLength(0);
  });
});

describe('Site Master wide table: the list filters', () => {
  it('sends the stage, mine or late, locks and gaps filters of the page to the rows endpoint with the same names as GET /sites', async () => {
    await signIn('pm');
    const urls: URL[] = [];
    server.use(http.get(`${API_BASE}/site-master/:menu/rows`, ({ request }) => { urls.push(new URL(request.url)); return HttpResponse.json({ total: 0, filtered: 0, offset: 0, limit: 200, rows: [] }); }));
    renderApp(<App />, { route: '/sites?section=cw&layout=wide&stage_code=MS2&bucket=late&workflow_locks=open&data_gaps=with&scenario=expansion' });
    await screen.findByTestId('sites-wide-table');
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    const p = urls[0]!.searchParams;
    expect([p.get('stage_code'), p.get('bucket'), p.get('workflow_locks'), p.get('data_gaps'), p.get('scenario')]).toEqual(['MS2', 'late', 'open', 'with', 'expansion']);
  });

  it('the sub-menu list sends the same filters (bucket=mine, stage and locks)', async () => {
    await signIn('pm');
    const urls: URL[] = [];
    server.use(http.get(`${API_BASE}/site-master/:menu/rows`, ({ request }) => { urls.push(new URL(request.url)); return HttpResponse.json({ total: 0, filtered: 0, offset: 0, limit: 200, rows: [] }); }));
    renderApp(<App />, { route: '/sites?section=te&bucket=mine&stage_code=MS2&workflow_locks=locked' });
    await waitFor(() => expect(urls.some((u) => u.searchParams.get('bucket') === 'mine' && u.searchParams.get('stage_code') === 'MS2' && u.searchParams.get('workflow_locks') === 'locked')).toBe(true));
  });
});
