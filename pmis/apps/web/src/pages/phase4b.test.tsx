import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, API_BASE, ApiError } from '@/api/client';
import type { Page, SiteTasks } from '@/api/types';
import { FollowButton } from '@/components/FollowButton';
import { MentionBox } from '@/components/Comments';
import { Shell } from '@/components/Shell';
import { TaskDrawer } from '@/components/TaskDrawer';
import { uid } from '@/mocks/ids';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { recId } from '@/mocks/registersData';
import { Inbox } from './Inbox';
import { RegisterPage } from './Register';
import { StatusUpdates } from './StatusUpdates';
import { Workload } from './Workload';

/** Phase 4b (X1 to X7) on the mock layer, which answers like the real API (contract 0.4.10 and 0.7.1). */
const MENTION_TASK = '10000000-0000-4000-8000-000000000001'; // WM105 D14 (the seeded mention points at it)
const fail = (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => e);
const inbox = (route = '/inbox', locale: 'en' | 'ar' = 'en') => renderApp(<Routes><Route path="/inbox" element={<Inbox />} /></Routes>, { route, locale });
const ids = () => screen.getAllByTestId(/^inbox-item-/).map((e) => e.getAttribute('data-testid')!.replace('inbox-item-', ''));
const N = (n: number) => `30000000-0000-4000-8000-00000000000${n}`;

describe('X1 inbox', () => {
  it('lists the visible items newest first, hides the snoozed one, and counts the unread', async () => {
    await signIn('pm');
    inbox();
    await screen.findByTestId('inbox-list');
    expect(ids()).toEqual([N(1), N(2), N(3), N(4)]); // newest first: 24 Oct 08:30, 23 Oct 10:00, 23 Oct 09:00, 22 Oct
    expect(screen.getByTestId('inbox-unread')).toHaveTextContent('3 unread');
    expect(screen.getByTestId(`inbox-item-${N(4)}`)).toHaveAttribute('data-read', 'true');
    expect(screen.getByTestId(`inbox-item-${N(3)}`)).toHaveAttribute('data-kind', 'mention');
    expect(screen.queryByTestId(`inbox-item-${N(5)}`)).toBeNull();
  });

  it('filters by unread, by kind and by the snoozed choice, and keeps the filter in the address', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    inbox();
    await screen.findByTestId('inbox-list');
    await u.click(screen.getByTestId('inbox-show-unread'));
    await waitFor(() => expect(ids()).toHaveLength(3));
    expect(screen.queryByTestId(`inbox-item-${N(4)}`)).toBeNull();
    await u.selectOptions(screen.getByTestId('inbox-kind'), 'mention');
    await waitFor(() => expect(ids()).toEqual([N(3)]));
    await u.selectOptions(screen.getByTestId('inbox-kind'), '');
    await u.click(screen.getByTestId('inbox-show-all'));
    await u.selectOptions(screen.getByTestId('inbox-snoozed'), 'only');
    await waitFor(() => expect(ids()).toEqual([N(5)]));
    expect(screen.getByTestId(`inbox-snoozed-chip-${N(5)}`)).toBeInTheDocument();
    await u.selectOptions(screen.getByTestId('inbox-snoozed'), 'include');
    await waitFor(() => expect(ids()).toHaveLength(5));
  });

  it('marks one read and unread, and all as read', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    inbox();
    await screen.findByTestId('inbox-list');
    await u.click(screen.getByTestId(`inbox-toggle-${N(1)}`));
    await waitFor(() => expect(screen.getByTestId(`inbox-item-${N(1)}`)).toHaveAttribute('data-read', 'true'));
    expect(screen.getByTestId('inbox-unread')).toHaveTextContent('2 unread');
    await u.click(screen.getByTestId(`inbox-toggle-${N(1)}`));
    await waitFor(() => expect(screen.getByTestId(`inbox-item-${N(1)}`)).toHaveAttribute('data-read', 'false'));
    await u.click(screen.getByTestId('inbox-read-all'));
    await waitFor(() => expect(screen.getByTestId('inbox-unread')).toHaveTextContent('0 unread'));
    expect(screen.getByTestId('inbox-read-all')).toBeDisabled();
    expect(await screen.findByTestId('toast')).toBeInTheDocument();
  });

  it('snoozes an item to a date (it leaves the list and shows under "only snoozed") and brings it back', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    inbox();
    await screen.findByTestId('inbox-list');
    await u.click(screen.getByTestId(`inbox-snooze-${N(2)}`));
    await u.click(await screen.findByTestId(`inbox-snooze-in_a_week-${N(2)}`));
    await waitFor(() => expect(screen.queryByTestId(`inbox-item-${N(2)}`)).toBeNull());
    expect(screen.getByTestId('inbox-unread')).toHaveTextContent('2 unread'); // a snoozed item does not count
    await u.selectOptions(screen.getByTestId('inbox-snoozed'), 'only');
    await waitFor(() => expect(ids().sort()).toEqual([N(2), N(5)].sort()));
    await u.click(screen.getByTestId(`inbox-snooze-${N(2)}`));
    await u.click(await screen.findByTestId(`inbox-unsnooze-${N(2)}`));
    await waitFor(() => expect(ids()).toEqual([N(5)]));
    await u.selectOptions(screen.getByTestId('inbox-snoozed'), 'hide');
    await waitFor(() => expect(screen.getByTestId(`inbox-item-${N(2)}`)).toBeInTheDocument());
  });

  it('refuses a snooze date in the past on the page (the pick button stays disabled) and in the API (422)', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    inbox();
    await screen.findByTestId('inbox-list');
    await u.click(screen.getByTestId(`inbox-snooze-${N(1)}`));
    const pick = await screen.findByTestId(`inbox-snooze-pick-${N(1)}`);
    expect(pick).toBeDisabled();
    await u.type(screen.getByTestId(`inbox-snooze-date-${N(1)}`), '2020-01-01');
    expect(pick).toBeDisabled();
    expect((await fail(api.post(`/notifications/${N(1)}/snooze`, { body: { until: '2020-01-01' } })))?.status).toBe(422);
    expect((await fail(api.post(`/notifications/${N(1)}/snooze`, { body: { until: 'tomorrow' } })))?.status).toBe(422);
    expect((await fail(api.post('/notifications/00000000-0000-4000-8000-0000000000ff/read')))?.status).toBe(404);
    expect((await fail(api.get('/notifications', { query: { kind: 'nope' } })))?.status).toBe(422);
  });

  it('opens a task notification in the drawer, marks it read, and shows the empty and error states', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    inbox();
    await screen.findByTestId('inbox-list');
    await u.click(screen.getByTestId(`inbox-open-${N(3)}`));
    expect(await screen.findByTestId('task-drawer-body')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId(`inbox-item-${N(3)}`)).toHaveAttribute('data-read', 'true'));
    expect(screen.getByTestId('drawer-open-site')).toBeInTheDocument();
  });

  it('shows the empty state when nothing is unread, and an error state with a retry', async () => {
    await signIn('pm');
    await api.post('/notifications/read-all');
    const u = userEvent.setup();
    inbox('/inbox?unread=1');
    expect(await screen.findByTestId('inbox-empty')).toHaveTextContent('No unread items');
    server.use(http.get(`${API_BASE}/notifications`, () => HttpResponse.json({ type: 'x', title: 'Boom', status: 500, code: 'unknown' }, { status: 500 })));
    await u.click(screen.getByTestId('inbox-show-all'));
    expect(await screen.findByTestId('inbox-error')).toBeInTheDocument();
    server.resetHandlers();
    await u.click(screen.getByTestId('inbox-error-retry'));
    expect(await screen.findByTestId('inbox-list')).toBeInTheDocument();
  });

  it('renders in Arabic with the right direction texts', async () => {
    await signIn('pm');
    inbox('/inbox', 'ar');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('صندوق الوارد');
    await screen.findByTestId('inbox-list');
    expect(screen.getByTestId('inbox-unread')).toHaveTextContent('3 غير مقروء');
    expect(screen.getByTestId('inbox-read-all')).toHaveTextContent('تعليم الكل كمقروء');
  });

  it('pages with "load more" when the server has another page', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const row = (n: number) => ({ id: `31000000-0000-4000-8000-00000000000${n}`, kind: 'system', title: `Item ${n}`, created_at: `2026-10-0${n}T10:00:00Z`, read_at: null });
    server.use(http.get(`${API_BASE}/notifications`, ({ request }) => {
      const first = !new URL(request.url).searchParams.get('cursor');
      return HttpResponse.json({ items: first ? [row(2), row(1)] : [row(0)], page: { limit: 2, next_cursor: first ? 'abc' : null }, unread_count: 3 });
    }));
    inbox();
    await screen.findByTestId('inbox-list');
    expect(ids()).toHaveLength(2);
    await u.click(screen.getByTestId('inbox-more'));
    await waitFor(() => expect(ids()).toHaveLength(3));
    expect(screen.queryByTestId('inbox-more')).toBeNull();
  });
});

describe('X1 bell', () => {
  const shell = () => renderApp(<Routes><Route element={<Shell />}><Route path="/inbox" element={<Inbox />} /><Route path="*" element={<div data-testid="elsewhere" />} /></Route></Routes>, { route: '/my-work' });

  it('shows the unread count, opens an item (marking it read and landing on it) and links to the inbox', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    shell();
    expect(await screen.findByTestId('bell-count')).toHaveTextContent('3');
    await u.click(screen.getByTestId('topbar-bell'));
    expect(await screen.findByTestId('bell-panel')).toBeInTheDocument();
    await u.click(await screen.findByTestId(`bell-item-${N(3)}`));
    expect(await screen.findByTestId('page-inbox')).toBeInTheDocument();
    expect(await screen.findByTestId('task-drawer-body')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('bell-count')).toHaveTextContent('2'));
    await u.keyboard('{Escape}'); // the task drawer is modal: close it to reach the bell again
    await waitFor(() => expect(screen.queryByTestId('task-drawer-body')).toBeNull());
    await u.click(screen.getByTestId('topbar-bell'));
    expect(await screen.findByTestId('bell-open-inbox')).toHaveAttribute('href', '/inbox');
  });
});

describe('X2 follow', () => {
  it('follows and stops following a site, and the button shows the state', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const sid = '50000000-0000-4000-8000-000000000001';
    renderApp(<FollowButton target={{ kind: 'site', id: sid }} entityId={sid} />);
    const b = await screen.findByTestId('follow-site');
    await waitFor(() => expect(b).toBeEnabled());
    expect(b).toHaveAttribute('aria-pressed', 'false');
    await u.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));
    expect(b).toHaveTextContent('Following');
    expect((await api.get<{ items: { entity_id: string; label: string }[] }>('/me/follows')).items.map((i) => i.entity_id)).toEqual([sid]);
    await u.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'false'));
    expect((await api.get<{ items: unknown[] }>('/me/follows')).items).toEqual([]);
  });

  it('shows the server refusal and leaves the button as it was', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const sid = '50000000-0000-4000-8000-000000000002';
    server.use(http.put(`${API_BASE}/sites/:id/follow`, () => HttpResponse.json({ type: 'x', title: 'Not found', status: 404, code: 'not_found' }, { status: 404 })));
    renderApp(<FollowButton target={{ kind: 'site', id: sid }} entityId={sid} />);
    const b = await screen.findByTestId('follow-site');
    await waitFor(() => expect(b).toBeEnabled());
    await u.click(b);
    expect(await screen.findByTestId('toast')).toHaveAttribute('data-kind', 'err');
    expect(b).toHaveAttribute('aria-pressed', 'false');
  });

  it('is idempotent in the API, 404 for an unknown site or record, and stopping something never followed is 204', async () => {
    await signIn('pm');
    const sid = '50000000-0000-4000-8000-000000000003';
    const a = await api.put<{ id: string }>(`/sites/${sid}/follow`);
    const b = await api.put<{ id: string }>(`/sites/${sid}/follow`);
    expect(b.id).toBe(a.id);
    expect((await api.get<{ items: unknown[] }>('/me/follows')).items).toHaveLength(1);
    expect((await fail(api.put('/sites/50000000-0000-4000-8000-0000000fffff/follow')))?.status).toBe(404);
    expect((await fail(api.put('/registers/procurement/records/00000000-0000-4000-8000-0000000000ff/follow')))?.status).toBe(404);
    await expect(api.del('/sites/50000000-0000-4000-8000-000000000009/follow')).resolves.toBeUndefined();
  });
});

describe('X3 mentions', () => {
  it('offers people after "@" and two letters, writes their ID token, and sends the ids of those picked', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const send = vi.fn();
    renderApp(<MentionBox label="Comment" pending={false} onSend={send} />);
    const box = screen.getByTestId('comment-input');
    await u.type(box, 'please check @s');
    expect(screen.queryByTestId('mention-list')).toBeNull(); // one letter is not enough
    await u.type(box, 'a');
    const list = await screen.findByTestId('mention-list');
    const opt = await within(list).findByTestId('mention-opt-1204');
    await u.click(opt);
    expect(box).toHaveValue('please check @1204 ');
    expect(screen.queryByTestId('mention-list')).toBeNull();
    await u.type(box, 'today');
    await u.click(screen.getByTestId('comment-send'));
    expect(send).toHaveBeenCalledWith('please check @1204 today', [uid('1204')]);
    expect(box).toHaveValue('');
  });

  it('drops a person whose token was deleted from the text, and sends no ids for plain text', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const send = vi.fn();
    renderApp(<MentionBox label="Comment" pending={false} onSend={send} />);
    const box = screen.getByTestId('comment-input');
    await u.type(box, '@sa');
    await u.click(await screen.findByTestId('mention-opt-1204'));
    await u.clear(box);
    await u.type(box, 'never mind');
    await u.click(screen.getByTestId('comment-send'));
    expect(send).toHaveBeenCalledWith('never mind', []);
  });

  it('keeps the send button off for an empty or blank comment, and Escape closes the list', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<MentionBox label="Comment" pending={false} onSend={vi.fn()} />);
    expect(screen.getByTestId('comment-send')).toBeDisabled();
    await u.type(screen.getByTestId('comment-input'), '   ');
    expect(screen.getByTestId('comment-send')).toBeDisabled();
    await u.clear(screen.getByTestId('comment-input'));
    await u.type(screen.getByTestId('comment-input'), '@sa');
    await screen.findByTestId('mention-list');
    await u.keyboard('{Escape}');
    expect(screen.queryByTestId('mention-list')).toBeNull();
  });

  it('a task comment shows who it reached and drops, without a sign, a person who cannot read the task', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<TaskDrawer taskId={MENTION_TASK} onClose={() => undefined} />);
    await screen.findByTestId('task-drawer-body');
    await u.click(screen.getByRole('tab', { name: 'Comments' }));
    await u.type(screen.getByTestId('comment-input'), 'ping @1204 and @1211 now');
    await u.click(screen.getByTestId('comment-send'));
    const list = await screen.findByTestId('comment-list');
    await waitFor(() => expect(within(list).getAllByTestId('mention-token')).toHaveLength(2)); // both tokens are shown as chips
    const reached = await within(list).findByTestId('comment-mentions');
    expect(reached).toHaveTextContent('Sami Nuri'); // 1204 can read it
    expect(reached).not.toHaveTextContent('Wael Saadi'); // 1211 cannot: no hint at all
  });

  it('a register record has a comment thread of its own with the same rules', async () => {
    await signIn('pm');
    const recs = await api.get<Page<{ id: string; entity_id: string }>>('/registers/procurement/records');
    const r = recs.items[0]!;
    const c = await api.post<{ mentions: { employee_id: string }[] }>(`/registers/procurement/records/${r.id}/comments`, { body: { body: 'see @1204 and @1211', mention_user_ids: [uid('1102')] } });
    expect(c.mentions.map((m) => m.employee_id).sort()).toEqual(['1102', '1204']);
    expect((await api.get<Page<unknown>>(`/registers/procurement/records/${r.id}/comments`)).items).toHaveLength(1);
    expect((await fail(api.post(`/registers/procurement/records/${r.id}/comments`, { body: { body: '  ' } })))?.status).toBe(422);
    expect((await fail(api.get('/registers/procurement/records/00000000-0000-4000-8000-0000000000ff/comments')))?.status).toBe(404);
  });
});

describe('X2 and X3 in the register drawer', () => {
  it('follows the record from its header and keeps a comment thread in its own tab, with the mention rule', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: `/registers/procurement?record=${recId(1)}` });
    const follow = await screen.findByTestId('follow-record');
    await waitFor(() => expect(follow).toBeEnabled());
    await u.click(follow);
    await waitFor(() => expect(follow).toHaveAttribute('aria-pressed', 'true'));
    await u.click(screen.getByRole('tab', { name: 'Comments' }));
    await u.type(await screen.findByTestId('comment-input'), 'ok @1204 @1211');
    await u.click(screen.getByTestId('comment-send'));
    const reached = await screen.findByTestId('comment-mentions');
    expect(reached).toHaveTextContent('Sami Nuri');
    expect(reached).not.toHaveTextContent('Wael Saadi');
    await u.click(follow);
    await waitFor(() => expect(follow).toHaveAttribute('aria-pressed', 'false'));
  });
});

describe('X4 time in state and X6 blocked-by', () => {
  it('shows the time in each level and the visits of a task in the Time tab', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<TaskDrawer taskId={MENTION_TASK} onClose={() => undefined} />);
    await screen.findByTestId('task-drawer-body');
    await u.click(screen.getByRole('tab', { name: 'Time' }));
    const panel = await screen.findByTestId('time-in-state');
    expect(within(panel).getByTestId('tis-row-entry')).toHaveTextContent('3 d');
    expect(within(panel).getByTestId('tis-row-approve')).toHaveTextContent('2 d');
    expect(within(panel).queryByTestId('tis-row-review')).toBeNull(); // the old middle level only appears when the task sat there
    expect(within(panel).getByTestId('tis-current')).toHaveTextContent('Now at: Approve');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
  });

  it('says so when a task has no recorded change', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/tasks/:id/time-in-state`, ({ params }) => HttpResponse.json({ task_id: params.id, current_state: null, items: ['entry', 'review', 'approve'].map((state) => ({ state, visits: 0, total_seconds: 0, longest_seconds: 0, working_days: 0 })), segments: [] })));
    const u = userEvent.setup();
    renderApp(<TaskDrawer taskId={MENTION_TASK} onClose={() => undefined} />);
    await screen.findByTestId('task-drawer-body');
    await u.click(screen.getByRole('tab', { name: 'Time' }));
    expect(await screen.findByTestId('tis-none')).toBeInTheDocument();
  });

  it('lists what a locked task waits for, with the earlier task as a link, and nothing for a free task', async () => {
    await signIn('pm');
    const site = '50000000-0000-4000-8000-000000000001';
    const grid = await api.get<SiteTasks>(`/sites/${site}/tasks`);
    const tasks = grid.stages.flatMap((s) => s.tasks);
    const locked = tasks.find((t) => t.state === 'locked' && (t.lock_reasons?.length ?? 0) > 0);
    expect(locked, 'the mock site has a locked task').toBeTruthy();
    const chain = await api.get<{ blocked: boolean; items: { kind: string; message: string; task?: { id: string; task_code: string } }[] }>(`/tasks/${locked!.id}/blocked-by`);
    expect(chain.blocked).toBe(true);
    renderApp(<Routes><Route path="/" element={<TaskDrawer taskId={locked!.id} onClose={() => undefined} />} /></Routes>);
    const panel = await screen.findByTestId('blocked-by');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(chain.items.length);
    const pred = chain.items.find((i) => i.task);
    if (pred?.task) expect(within(panel).getByTestId(`blocked-task-${pred.task.task_code}`)).toHaveAttribute('href', `/sites/${site}?task=${pred.task.id}`);
    const free = tasks.find((t) => t.state !== 'locked' && !(t.lock_reasons?.length));
    expect((await api.get<{ blocked: boolean; items: unknown[] }>(`/tasks/${free!.id}/blocked-by`))).toMatchObject({ blocked: false, items: [] });
    expect((await fail(api.get('/tasks/00000000-0000-4000-8000-0000000000ff/blocked-by')))?.status).toBe(404);
  });
});

describe('X5 workload and the time report', () => {
  it('lists open and late tasks per person, latest trouble first, and a lead opens the reassign decision for a person', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/workload" element={<Workload />} /></Routes>, { route: '/workload' });
    const table = await screen.findByTestId('workload-table');
    const rows = within(table).getAllByTestId(/^workload-row-/);
    expect(rows.length).toBeGreaterThan(0);
    const lates = rows.map((r) => Number(within(r).getByTestId('workload-late').textContent));
    expect(lates).toEqual([...lates].sort((a, b) => b - a));
    const first = rows[0]!;
    const emp = first.getAttribute('data-testid')!.replace('workload-row-', '');
    await u.click(within(first).getByTestId(`workload-reassign-${emp}`));
    const dlg = await screen.findByTestId('cover-dialog');
    expect(within(dlg).getByTestId('cover-person-only')).toBeInTheDocument();
    expect(within(dlg).queryByTestId('cover-scope')).toBeNull(); // the Workload view decides about the person's open tasks only
    await u.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('cover-dialog')).toBeNull());
    // the region filter narrows it, and the time report sits below
    await u.selectOptions(screen.getByTestId('workload-region'), '1');
    await waitFor(() => expect(within(screen.getByTestId('workload-table')).getAllByTestId(/^workload-row-/).length).toBeLessThanOrEqual(rows.length));
    expect(await screen.findByTestId('time-table')).toBeInTheDocument();
    await u.click(screen.getByTestId('time-group-team'));
    await waitFor(() => expect(screen.getByTestId('time-row-cw')).toHaveTextContent('2 d'));
  });

  it('is closed to someone without Reports: 403 in the API and the no-permission state on the page', async () => {
    await signIn('engineer');
    expect((await fail(api.get('/reports/workload')))?.status).toBe(403);
    expect((await fail(api.get('/reports/time-in-state')))?.status).toBe(403);
    renderApp(<Routes><Route path="/workload" element={<Workload />} /></Routes>, { route: '/workload' });
    expect(await screen.findByTestId('workload-forbidden')).toBeInTheDocument();
  });

  it('refuses a bad region in the API (422)', async () => {
    await signIn('pm');
    for (const r of ['0', '8', 'x']) expect((await fail(api.get('/reports/workload', { query: { region_id: r } })))?.status, r).toBe(422);
  });
});

describe('X7 weekly status updates', () => {
  const page = () => renderApp(<Routes><Route path="/status-updates" element={<StatusUpdates />} /></Routes>, { route: '/status-updates' });

  it('groups the updates by week, newest week first, with health and author', async () => {
    await signIn('pm');
    page();
    await screen.findByTestId('status-update-40000000-0000-4000-8000-000000000001');
    const weeks = screen.getAllByTestId(/^status-week-/).map((e) => e.getAttribute('data-testid')!.replace('status-week-', ''));
    expect(weeks).toHaveLength(2);
    expect(weeks[0]! > weeks[1]!).toBe(true);
    expect(screen.getByTestId('status-health-chip-40000000-0000-4000-8000-000000000002')).toHaveTextContent('At risk');
    expect(screen.getByTestId('status-update-40000000-0000-4000-8000-000000000003')).toHaveAttribute('data-health', 'off_track');
  });

  it('lets a lead write an update (the form needs a region and a summary) and edit it inside the week', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    await screen.findByTestId('status-new');
    await u.click(screen.getByTestId('status-new'));
    const dlg = await screen.findByTestId('status-dialog');
    expect(within(dlg).getByTestId('status-dialog-submit')).toBeDisabled();
    await u.selectOptions(within(dlg).getByTestId('status-region'), '3');
    await u.type(within(dlg).getByTestId('status-summary'), 'Zawia is fine.');
    await u.click(within(dlg).getByTestId('status-health-at_risk'));
    await u.click(within(dlg).getByTestId('status-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('status-dialog')).toBeNull());
    const mine = (await screen.findAllByText('Zawia is fine.'))[0]!.closest('li')!;
    expect(mine).toHaveAttribute('data-health', 'at_risk');
    const id = mine.getAttribute('data-testid')!.replace('status-update-', '');
    await u.click(screen.getByTestId(`status-edit-${id}`));
    const edit = await screen.findByTestId('status-dialog');
    expect(within(edit).queryByTestId('status-region')).toBeNull(); // only health and summary change
    await u.click(within(edit).getByTestId('status-health-off_track'));
    await u.click(within(edit).getByTestId('status-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId(`status-update-${id}`)).toHaveAttribute('data-health', 'off_track'));
  });

  it('shows no write button to someone who is not a lead, and the API answers 403', async () => {
    await signIn('engineer');
    page();
    await screen.findByTestId('status-update-40000000-0000-4000-8000-000000000001');
    expect(screen.queryByTestId('status-new')).toBeNull();
    expect(screen.queryByTestId('status-edit-40000000-0000-4000-8000-000000000001')).toBeNull();
    const err = await fail(api.post('/status-updates', { body: { scope: 'region', region_id: 1, health: 'on_track', summary: 'Forged' } }));
    expect(err?.status).toBe(403);
    expect(err?.code).toBe('action_forbidden');
  });

  it('validates in the API: the shape, the health, an empty or long summary, and If-Match on edit', async () => {
    await signIn('pm');
    const ok = { scope: 'region', region_id: 2, health: 'on_track', summary: 'Fine.' };
    for (const bad of [{ ...ok, region_id: undefined }, { ...ok, team: 'cw' }, { scope: 'team', health: 'on_track', summary: 'x' }, { ...ok, health: 'fine' }, { ...ok, summary: '  ' }, { ...ok, summary: 'x'.repeat(4001) }]) {
      expect((await fail(api.post('/status-updates', { body: bad })))?.status, JSON.stringify(bad).slice(0, 40)).toBe(422);
    }
    const made = await api.post<{ id: string; version: number }>('/status-updates', { body: ok });
    expect((await fail(api.patch(`/status-updates/${made.id}`, { body: { health: 'at_risk' } })))?.status).toBe(428);
    expect((await fail(api.patch(`/status-updates/${made.id}`, { version: 9, body: { health: 'at_risk' } })))?.status).toBe(412);
    expect((await fail(api.patch(`/status-updates/${made.id}`, { version: made.version, body: {} })))?.status).toBe(422);
    const edited = await api.patch<{ version: number; health: string }>(`/status-updates/${made.id}`, { version: made.version, body: { health: 'at_risk' } });
    expect(edited).toMatchObject({ version: 2, health: 'at_risk' });
  });

  it('renders the page in Arabic', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/status-updates" element={<StatusUpdates />} /></Routes>, { route: '/status-updates', locale: 'ar' });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('الحالة الأسبوعية');
    await screen.findByTestId('status-new');
    expect(screen.getByTestId('status-new')).toHaveTextContent('اكتب تحديثًا');
  });
});

describe('navigation (X1, X5, X7)', () => {
  const shell = () => renderApp(<Routes><Route element={<Shell />}><Route path="*" element={<div />} /></Route></Routes>, { route: '/my-work' });
  it('gives everyone the inbox, the status updates to readers of Sites, and the workload to readers of Reports', async () => {
    await signIn('pm');
    shell();
    expect(await screen.findByTestId('nav-inbox')).toBeInTheDocument();
    expect(screen.getByTestId('nav-workload')).toBeInTheDocument();
    expect(screen.getByTestId('nav-status_updates')).toBeInTheDocument();
  });
  it('hides the workload from someone without Reports and everything but the inbox from the auditor', async () => {
    await signIn('engineer');
    shell();
    expect(await screen.findByTestId('nav-inbox')).toBeInTheDocument();
    expect(screen.getByTestId('nav-status_updates')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-workload')).toBeNull();
  });
  it('the auditor sees the inbox but not the status updates', async () => {
    await signIn('auditor');
    shell();
    expect(await screen.findByTestId('nav-inbox')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-status_updates')).toBeNull();
    expect(screen.queryByTestId('nav-workload')).toBeNull();
  });
});
