import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  it('names the module Site Register and offers All, the four API streams and Dismantle, in EN and AR', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites' });
    expect(screen.getByRole('heading', { name: 'Site Register' })).toBeInTheDocument();
    for (const c of ['ALL', 'DESIGN_ACQ', 'CW', 'TE', 'CLOSURE', 'DISMANTLE']) expect(await screen.findByTestId(`stream-tab-${c}`)).toBeInTheDocument();
    expect(screen.getByTestId('stream-tab-DESIGN_ACQ')).toHaveTextContent('Design & Acquisition');
  });

  it('shows the agreed Arabic names', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites', locale: 'ar' });
    const names = ['الكل', 'التصميم والاستحواذ', 'الأعمال المدنية', 'التركيبات', 'التسليم والإغلاق', 'الفك'];
    await waitFor(() => expect(within(screen.getByTestId('stream-tabs')).getAllByRole('tab').map((x) => x.textContent)).toEqual(names));
    expect(screen.getByRole('heading', { name: 'سجل المواقع' })).toBeInTheDocument();
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

  it('Dismantle has no API stream yet: it explains that and fetches nothing', async () => {
    await signIn('pm');
    const seen: (string | null)[] = [];
    server.events.on('request:start', ({ request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/sites')) seen.push(u.searchParams.get('stream')); });
    renderApp(<Sites />, { route: '/sites?stream=DISMANTLE' });
    expect(await screen.findByTestId('stream-dismantle-todo')).toBeInTheDocument();
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
