import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, API_BASE, ApiError } from '@/api/client';
import type { Page, SiteListItem, SiteTasks, TaskDetail } from '@/api/types';
import i18n from '@/i18n';
import { taskErrorMessage } from '@/lib/taskErrors';
import { DEFAULT_STREAMS, withDismantle } from '@/lib/streams';
import { touch, siteIdOf, taskIdOf } from '@/mocks/sites';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Route, Routes } from 'react-router-dom';
import { Approvals } from './Approvals';
import { Site } from './Site';
import { Sites } from './Sites';

const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
const A1 = taskIdOf(0, 0);

describe('Site Register: streams', () => {
  it('names the module Site Register, has no tab bars (the sidebar switches) and titles the open stream with the API name', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites' });
    expect(screen.getByRole('heading', { name: 'Site Register' })).toBeInTheDocument();
    expect(await screen.findByTestId('site-row-TR101')).toBeInTheDocument();
    expect(document.querySelector('[data-stream="ALL"]')).not.toBeNull();
    expect(screen.queryByTestId('stream-tabs')).toBeNull();
    expect(screen.queryByTestId('view-tabs')).toBeNull();
    cleanup();
    for (const [code, name] of [['DESIGN_ACQ', 'Design & Acquisition'], ['CW', 'Civil Works'], ['TE', 'Installation (TE)'], ['CLOSURE', 'Handover & Closure']]) {
      renderApp(<Sites />, { route: `/sites?stream=${code}` });
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`Site Register: ${name}`);
      await waitFor(() => expect(document.querySelector(`[data-stream="${code}"]`)).not.toBeNull());
      cleanup();
    }
  });

  it('shows the agreed Arabic names in the title of each stream', async () => {
    await signIn('pm');
    const names = { DESIGN_ACQ: 'التصميم والاستحواذ', CW: 'الأعمال المدنية', TE: 'التركيبات', CLOSURE: 'التسليم والإغلاق' };
    renderApp(<Sites />, { route: '/sites', locale: 'ar' });
    expect(screen.getByRole('heading', { name: 'سجل المواقع' })).toBeInTheDocument();
    cleanup();
    for (const [code, name] of Object.entries(names)) {
      renderApp(<Sites />, { route: `/sites?stream=${code}`, locale: 'ar' });
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`سجل المواقع: ${name}`);
      cleanup();
    }
  });

  it('calls GET /sites?stream=CW and shows stage, done/total, late and milestone per site; N/A sites sit behind a toggle', async () => {
    await signIn('pm');
    const streams: (string | null)[] = [];
    server.events.on('request:start', ({ request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/sites')) streams.push(u.searchParams.get('stream')); });
    renderApp(<Sites />, { route: '/sites?stream=CW' });
    await waitFor(() => expect(screen.getByTestId('sites-show-na-label')).toHaveTextContent(/Show N\/A sites \([1-9]/));
    expect(streams).toContain('CW');
    const row = await screen.findByTestId('site-row-TR101');
    expect(row).toHaveAttribute('data-stream-state');
    expect(within(row).getByTestId('stream-progress-TR101')).toHaveTextContent(/^\d+\/\d+$/);
    expect(within(row).getByTestId('stream-ms-TR101')).toBeInTheDocument();
    const before = Number(screen.getByTestId('sites-count').textContent?.match(/\d+/)?.[0]);
    const na = Number(screen.getByTestId('sites-show-na-label').textContent?.match(/\((\d+)\)/)?.[1]);
    expect(screen.queryAllByTestId(/^stream-state-/).every((e) => e.textContent !== 'N/A')).toBe(true);
    await userEvent.click(screen.getByTestId('sites-show-na'));
    await waitFor(() => expect(Number(screen.getByTestId('sites-count').textContent?.match(/\d+/)?.[0])).toBe(before + na));
  });

  it('an old ?stream=DISMANTLE link lands on the Dismantle register and fetches no site list for it', async () => {
    await signIn('pm');
    const seen: (string | null)[] = [];
    server.events.on('request:start', ({ request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/sites')) seen.push(u.searchParams.get('stream')); });
    renderApp(<Routes><Route path="/sites" element={<Sites />} /><Route path="/registers/dismantle" element={<div data-testid="at-dismantle" />} /></Routes>, { route: '/sites?stream=DISMANTLE' });
    expect(await screen.findByTestId('at-dismantle')).toBeInTheDocument();
    expect(seen).not.toContain('DISMANTLE');
  });

  it('rejects an unknown stream with 422 and keeps the fallback list', async () => {
    await signIn('pm');
    await expect(api.get('/sites', { query: { stream: 'NOPE' } })).rejects.toMatchObject({ status: 422 });
    expect(withDismantle(undefined).map((s) => s.code)).toEqual([...DEFAULT_STREAMS.map((s) => s.code), 'DISMANTLE']);
    expect(withDismantle(DEFAULT_STREAMS.slice(0, 1)).map((s) => s.code)).toEqual(['DESIGN_ACQ', 'DISMANTLE']);
  });

  it('the site page grid and pipeline follow the stream', async () => {
    await signIn('pm');
    const id = siteIdOf(0);
    const all = await api.get<SiteTasks>(`/sites/${id}/tasks`);
    const cw = await api.get<SiteTasks>(`/sites/${id}/tasks`, { query: { stream: 'CW' } });
    expect(all.stages).toHaveLength(10);
    expect(cw.stages.map((s) => s.stream_code)).toEqual(['CW', 'CW', 'CW']);
    renderApp(<SiteAt />, { route: `/sites/${id}?stream=CW` });
    expect(await screen.findByTestId('site-stream-summary')).toBeInTheDocument();
    expect(await screen.findAllByTestId(/^pipe-node-/)).toHaveLength(3);
    expect(screen.queryByTestId('grid-stage-site_release')).toBeNull();
    expect(await screen.findByTestId('grid-stage-cw')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('site-stream-tab-ALL'));
    expect(await screen.findAllByTestId(/^pipe-node-/)).toHaveLength(10);
  });

  it('list items carry the real StreamStatus shape', async () => {
    await signIn('pm');
    const r = await api.get<Page<SiteListItem>>('/sites', { query: { stream: 'TE', limit: 5 } });
    const s = r.items[0].streams?.find((x) => x.code === 'TE');
    expect(s).toMatchObject({ code: 'TE', name_ar: 'التركيبات' });
    expect(typeof s?.done_tasks).toBe('number');
    expect(r.items[0].rail.length).toBe(4);
  });
});

describe('Site Register: views (contract 0.4.7)', () => {
  it('titles the open view with the name from the API, in EN and AR, and shows no tab bars', async () => {
    await signIn('pm');
    for (const [view, en, ar] of [['CW', 'CW Register', 'سجل الأعمال المدنية'], ['TE', 'TE Register', 'سجل التركيبات'], ['OM', 'O&M', 'التشغيل والصيانة']]) {
      renderApp(<Sites />, { route: `/sites?view=${view}` });
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`Site Register: ${en}`));
      expect(screen.queryByTestId('view-tabs')).toBeNull();
      expect(screen.queryByTestId('stream-tabs')).toBeNull();
      cleanup();
      renderApp(<Sites />, { route: `/sites?view=${view}`, locale: 'ar' });
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`سجل المواقع: ${ar}`));
      cleanup();
    }
  });

  it('passes view to GET /sites from the URL (an old ?view=CW link) and combines it with the stream', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/sites') && u.searchParams.get('view')) seen.push(u.search); });
    renderApp(<Sites />, { route: '/sites?stream=CW&view=CW' });
    await waitFor(() => expect(seen.some((q) => q.includes('view=CW') && q.includes('stream=CW'))).toBe(true));
    expect(await screen.findByTestId('site-row-TR101')).toHaveAttribute('href', expect.stringMatching(/stream=CW&view=CW/));
    cleanup();
    renderApp(<Sites />, { route: '/sites?stream=CW&view=TE' });
    expect(await screen.findByTestId('sites-empty')).toBeInTheDocument(); // stream CW and view TE share no task
  });

  it('on the site page the view tabs still move with the arrow keys (mirrored in RTL)', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}` });
    const all = await screen.findByTestId('site-view-tabs-ALL');
    all.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('site-view-tabs-CW')).toHaveAttribute('aria-selected', 'true');
  });

  it('the real 0.4.7 shapes: B15 in CW, D18 in TE, B14 in OM (O&M not assigned); stage 1 and Z1 only in All work', async () => {
    await signIn('pm');
    const id = siteIdOf(0);
    const codes = async (view?: string) => (await api.get<SiteTasks>(`/sites/${id}/tasks`, { query: { view } })).stages.flatMap((st) => st.tasks.map((x) => x.task_code));
    const [cw, te, om, all] = await Promise.all([codes('CW'), codes('TE'), codes('OM'), codes()]);
    expect(cw).toContain('B15'); expect(cw).not.toContain('D18'); expect(cw).not.toContain('B14'); expect(cw).not.toContain('A1');
    expect(te).toContain('D18'); expect(te).not.toContain('B15');
    expect(om).toEqual(['B14']);
    expect(all).toEqual(expect.arrayContaining(['A1', 'B14', 'B15', 'D18']));
    const grid = await api.get<SiteTasks>(`/sites/${id}/tasks`);
    expect(grid.views?.map((v) => v.code)).toEqual(['CW', 'TE', 'OM']);
    const list = await api.get<Page<SiteListItem>>('/sites', { query: { view: 'OM', limit: 3 } });
    expect(list.items[0].views?.map((v) => v.code)).toEqual(['CW', 'TE', 'OM']);
    await expect(api.get('/sites', { query: { view: 'NOPE' } })).rejects.toMatchObject({ status: 422 });
  });

  it('the site page grid follows the view and the stream together (intersection)', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}?view=TE` });
    expect(await screen.findByTestId('grid-stage-te_installation')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-stage-cw')).toBeNull();
    await userEvent.click(await screen.findByTestId('site-view-tabs-OM'));
    await waitFor(() => expect(screen.queryByTestId('grid-stage-te_installation')).toBeNull());
    await userEvent.click(screen.getByTestId('site-view-tabs-ALL'));
    expect(await screen.findByTestId('grid-stage-cw')).toBeInTheDocument();
  });
});

describe('Task actions on the real endpoints', () => {
  const asReviewer = async () => {
    await signIn('reviewer');
    const t0 = await api.get<TaskDetail>(`/tasks/${A1}`);
    await api.patch(`/tasks/${A1}`, { version: t0.version, body: { actual_date: '2026-10-20' } });
    await api.post(`/tasks/${A1}/slots/${t0.slots[0].id}/files`, { body: (() => { const f = new FormData(); f.append('file', new File(['%PDF-1.4'], 'sar.pdf', { type: 'application/pdf' })); return f; })() });
    const t1 = await api.get<TaskDetail>(`/tasks/${A1}`);
    await api.post(`/tasks/${A1}/submit`, { version: t1.version });
    await signIn('pm');
  };

  it('sends If-Match on every action', async () => {
    await asReviewer();
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { if (request.method === 'POST' && /\/tasks\/[^/]+\/(claim|release)$/.test(request.url)) seen.push(`${request.url.split('/').pop()} ${request.headers.get('If-Match')}`); });
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}?task=${A1}` });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('drawer-claim'));
    expect(await screen.findByTestId('drawer-claimed-by')).toBeInTheDocument();
    await u.click(await screen.findByTestId('drawer-release'));
    await waitFor(() => expect(screen.queryByTestId('drawer-claimed-by')).toBeNull());
    expect(seen).toHaveLength(2);
    expect(seen.every((x) => /^(claim|release) "\d+"$/.test(x))).toBe(true);
  });

  it('says in plain words that another holder has claimed the level (409 already_claimed)', async () => {
    await asReviewer();
    const t = touch(A1)!;
    t.claimed_by = { id: '00000000-0000-4000-8000-000000000042', display_name: 'Mona Fathi' };
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}?task=${A1}` });
    await api.post('/__mock/step-up');
    await userEvent.click(await screen.findByTestId('drawer-approve'));
    expect(await screen.findByText('Mona Fathi has already claimed this level.')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-state')).toHaveTextContent('Awaiting approval'); // rolled back
  });

  it('says in plain words that snags are open (422 open_snags) and rolls back', async () => {
    await signIn('pm');
    const id = siteIdOf(1);
    const grid = await api.get<SiteTasks>(`/sites/${id}/tasks`);
    const pac = grid.stages.flatMap((s) => s.tasks).find((x) => x.task_code === 'B13')!;
    const t = touch(pac.id)!;
    Object.assign(t, { state: 'in_approval', level_kind: 'approve', current_level: 3 });
    await api.post('/__mock/step-up');
    renderApp(<SiteAt />, { route: `/sites/${id}?task=${pac.id}` });
    await userEvent.click(await screen.findByTestId('drawer-approve'));
    expect(await screen.findByText(/while snags are still open/)).toBeInTheDocument();
    expect(screen.getByTestId('drawer-state')).toHaveTextContent('Awaiting approval');
  });

  it('starts an open task (POST /start)', async () => {
    await signIn('reviewer');
    const g = await api.get<SiteTasks>(`/sites/${siteIdOf(11)}/tasks`);
    const open = g.stages.flatMap((s) => s.tasks).find((x) => x.state === 'open')!;
    expect(open).toBeTruthy();
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(11)}?task=${open.id}` });
    await userEvent.click(await screen.findByTestId('drawer-start'));
    await waitFor(() => expect(screen.getByTestId('drawer-state')).toHaveTextContent('Entry'));
  });

  it('save sends the changed dates and rolls the screen back when the server refuses', async () => {
    await signIn('reviewer');
    server.use(http.patch(`${API_BASE}/tasks/:id`, () => HttpResponse.json({ type: 'about:blank', title: 'x', status: 412, code: 'precondition_failed' }, { status: 412 })));
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}?task=${A1}` });
    fireEvent.change(await screen.findByTestId('drawer-actual-date'), { target: { value: '2026-10-21' } });
    await userEvent.click(screen.getByTestId('drawer-save'));
    expect(await screen.findByText(/Someone changed this/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId(`grid-cell-${A1}-actual`)).not.toHaveTextContent('2026-10-21'));
  });

  it('plain words for every engine code', () => {
    const t = i18n.t.bind(i18n);
    const err = (code: string, status: number, extra: object = {}) => new ApiError(status, { type: 'about:blank', title: code, status, code, ...extra } as never);
    expect(taskErrorMessage(t, err('open_snags', 422))).toMatch(/snags are still open/);
    expect(taskErrorMessage(t, err('mandatory_fields_missing', 422, { missing: ['actual_date'] }))).toBe('Fill the mandatory fields first: actual_date.');
    expect(taskErrorMessage(t, err('mandatory_slots_missing', 422))).toBe('Upload the mandatory documents first.');
    expect(taskErrorMessage(t, err('note_required', 422))).toMatch(/note/);
    expect(taskErrorMessage(t, err('already_claimed', 409, { claimed_by: { display_name: 'Sami' } }))).toBe('Sami has already claimed this level.');
    expect(taskErrorMessage(t, err('not_eligible_holder', 403))).toMatch(/do not hold/);
    expect(taskErrorMessage(t, err('step_up_required', 401))).toBe('');
  });

  it('rejects without a note with 422 note_required', async () => {
    await asReviewer();
    const t = await api.get<TaskDetail>(`/tasks/${A1}`);
    await expect(api.post(`/tasks/${A1}/reject`, { version: t.version, body: {} })).rejects.toMatchObject({ status: 422, code: 'note_required' });
  });
});

describe('Approvals on the real shapes', () => {
  it('bulk pass reports what was skipped and why', async () => {
    await signIn('reviewer');
    renderApp(<Approvals />, { route: '/approvals' });
    const checks = await screen.findAllByTestId(/^approval-check-/);
    await userEvent.click(checks[0]);
    server.use(http.post(`${API_BASE}/approvals/bulk`, async ({ request }) => {
      const b = (await request.json()) as { items: { id: string }[] };
      return HttpResponse.json({ bulk_action_id: 'x', done: [], skipped: [{ ref: b.items[0].id, code: 'already_claimed' }], failed: [] });
    }));
    const pass = screen.queryByTestId('bulk-pass') ?? screen.getByTestId('bulk-approve');
    await userEvent.click(pass);
    expect(await screen.findByTestId('bulk-report')).toHaveTextContent('Another holder has already claimed this level.');
  });
});

describe('Task register fields (contract 0.4.9)', () => {
  const open = async (locale: 'en' | 'ar', site: number, idx: number) => {
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(site)}?task=${taskIdOf(site, idx)}`, locale });
    return screen.findByTestId('task-register-fields');
  };
  it('patches a record in entry through the register endpoint and refetches the tasks (B2, site 3)', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const sec = await open('en', 2, 5);
    const row = within(sec).getByTestId('regfield-po_wo_no');
    expect(within(row).getByTestId('regfield-po_wo_no-source')).toHaveTextContent(/^from /);
    expect(within(row).getByTestId('regfield-po_wo_no-source').getAttribute('href')).toMatch(/^\/registers\/procurement\?record=/);
    await u.click(within(row).getByTestId('regfield-po_wo_no-edit'));
    const input = within(row).getByTestId('regfield-po_wo_no-input');
    await u.clear(input); await u.type(input, 'WO-2026-099');
    await u.click(within(row).getByTestId('regfield-po_wo_no-save'));
    await waitFor(() => expect(within(screen.getByTestId('regfield-po_wo_no')).getByTestId('regfield-po_wo_no-value')).toHaveTextContent('WO-2026-099'));
  });
  it('creates a new version of an approved record, then patches it (B1, site 1)', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const sec = await open('en', 0, 4);
    const row = within(sec).getByTestId('regfield-pr_no');
    expect(row).toHaveAttribute('data-edit-via', 'new_version');
    await u.click(within(row).getByTestId('regfield-pr_no-edit'));
    const input = within(row).getByTestId('regfield-pr_no-input');
    await u.clear(input); await u.type(input, 'PR-NEW-1');
    await u.click(within(row).getByTestId('regfield-pr_no-save'));
    await waitFor(() => expect(screen.getByTestId('regfield-pr_no')).toHaveAttribute('data-edit-via', 'patch'));
    expect(screen.getByTestId('regfield-pr_no-value')).toHaveTextContent('PR-NEW-1');
  });
  it('is read-only when edit_via is none (HLC record in review), with the Arabic label and source', async () => {
    await signIn('pm');
    const sec = await open('ar', 1, 14);
    const row = within(sec).getByTestId('regfield-fiber_status');
    expect(row).toHaveAttribute('data-edit-via', 'none');
    expect(within(row).queryByTestId('regfield-fiber_status-edit')).toBeNull();
    expect(within(row).getByTestId('regfield-fiber_status-readonly')).toBeInTheDocument();
    expect(within(row).getByText('حالة الألياف')).toBeInTheDocument();
    expect(within(row).getByTestId('regfield-fiber_status-source').textContent).toMatch(/^من /);
  });
  it('shows the register error in plain words when the register refuses (permission denied)', async () => {
    await signIn('pm');
    server.use(http.patch(`${API_BASE}/registers/procurement/records/:id`, () => HttpResponse.json({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'not_eligible_holder' }, { status: 403, headers: { 'Content-Type': 'application/problem+json' } })));
    const u = userEvent.setup();
    const sec = await open('en', 2, 5);
    await u.click(within(sec).getByTestId('regfield-po_wo_no-edit'));
    await u.type(within(sec).getByTestId('regfield-po_wo_no-input'), 'x');
    await u.click(within(sec).getByTestId('regfield-po_wo_no-save'));
    expect(await screen.findByText(i18n.t('taskErrors.not_eligible_holder'))).toBeInTheDocument();
    expect(within(sec).getByTestId('regfield-po_wo_no-save')).toBeInTheDocument();
  });
});
