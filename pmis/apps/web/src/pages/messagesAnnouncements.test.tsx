import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { api, API_BASE } from '@/api/client';
import { AnnouncementPopup } from '@/components/AnnouncementPopup';
import { uid } from '@/mocks/ids';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { AnnouncementResults } from './AnnouncementResults';
import { Announcements } from './Announcements';
import { Messages } from './Messages';
import { UserDetailPage } from './UserDetail';
import { Users } from './Users';

const stepUpDone = () => api.post('/__mock/step-up');
const T1 = '97000000-0000-4000-8000-000000000001'; // Ali Barka (1103) -> Mona Fathi (1102): original + 2 replies, unread for Mona
const A1 = '99000000-0000-4000-8000-000000000001';
const messagesAt = (route = '/messages') => renderApp(<Routes><Route path="/messages" element={<Messages />} /><Route path="/messages/:threadId" element={<Messages />} /></Routes>, { route });
const before = (a: HTMLElement, b: HTMLElement) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const problemJson = (status: number, code: string, errors?: { path: string; code: string }[]) =>
  HttpResponse.json({ type: 'x', title: code, status, code, ...(errors ? { errors } : {}) }, { status, headers: { 'Content-Type': 'application/problem+json' } });

describe('messages', () => {
  it('shows the original first, the reply box directly under it, then the replies newest first, and marks the thread read', async () => {
    await signIn('reviewer');
    messagesAt(`/messages/${T1}`);
    const original = await screen.findByTestId('msg-original');
    const box = screen.getByTestId('reply-box');
    const list = await screen.findByTestId('reply-list');
    expect(before(original, box)).toBe(true);
    expect(before(box, list)).toBe(true);
    // nothing between the original and the reply box
    expect(original.nextElementSibling).toBe(box);
    expect(box.nextElementSibling).toBe(list);
    const replies = within(list).getAllByTestId(/^reply-(?!list)[0-9a-f-]+$/);
    expect(replies.map((r) => r.textContent)).toEqual([expect.stringContaining('Understood, thank you.'), expect.stringContaining('Start with WM105')]);
    expect(original).toHaveTextContent('Can you confirm the order?');
    // opening the thread marks it read: the dot and the unread total go away
    await waitFor(() => expect(screen.queryByTestId(`thread-unread-${T1}`)).toBeNull());
    await waitFor(async () => expect((await api.get<{ unread_total: number }>('/messages/threads')).unread_total).toBe(1)); // the PM's "Weekly report format" is still unread
  });

  it('keeps line breaks and does not render HTML', async () => {
    await signIn('reviewer');
    const u = userEvent.setup();
    messagesAt(`/messages/${T1}`);
    await u.type(await screen.findByTestId('reply-body'), '<b>bold</b>{Enter}second line');
    await u.click(screen.getByTestId('reply-send'));
    const first = (await screen.findByTestId('reply-list')).querySelector('[data-testid$="-body"]') as HTMLElement;
    await waitFor(() => expect(first.textContent).toBe('<b>bold</b>\nsecond line'));
    expect(first.querySelector('b')).toBeNull();
    expect(first.className).toContain('whitespace-pre-wrap');
  });

  it('puts a new reply at the top at once, and takes it back with the text when the server refuses', async () => {
    await signIn('reviewer');
    const u = userEvent.setup();
    messagesAt(`/messages/${T1}`);
    await screen.findByTestId('msg-original');
    await u.type(screen.getByTestId('reply-body'), 'Confirmed, see you there');
    await u.click(screen.getByTestId('reply-send'));
    await waitFor(() => expect(within(screen.getByTestId('reply-list')).getAllByTestId(/^reply-(?!list)/)[0]).toHaveTextContent('Confirmed, see you there'));
    expect(within(screen.getByTestId('reply-list')).getAllByTestId(/^reply-(?!list)[0-9a-f-]+$/)).toHaveLength(3);

    let release: () => void = () => {};
    server.use(http.post(`${API_BASE}/messages/threads/:id/replies`, async () => { await new Promise<void>((r) => { release = r; }); return problemJson(403, 'action_forbidden'); }));
    await u.type(screen.getByTestId('reply-body'), 'This one fails');
    await u.click(screen.getByTestId('reply-send'));
    await waitFor(() => expect(within(screen.getByTestId('reply-list')).getAllByTestId(/^reply-(?!list)/)[0]).toHaveTextContent('This one fails')); // optimistic
    release();
    expect(await screen.findByTestId('reply-error')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId('reply-list')).queryByText('This one fails')).toBeNull());
    expect(screen.getByTestId('reply-body')).toHaveValue('This one fails'); // the text is back in the box
  });

  it('lists my threads with the other person, their ID, a preview and the unread dot, and filters unread only', async () => {
    await signIn('reviewer');
    const u = userEvent.setup();
    messagesAt();
    const row = await screen.findByTestId(`thread-${T1}`);
    expect(row).toHaveTextContent('Ali Barka');
    expect(row).toHaveTextContent('1103');
    expect(screen.getByTestId(`thread-preview-${T1}`)).toHaveTextContent('Understood, thank you.');
    expect(screen.getByTestId(`thread-unread-${T1}`)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^thread-[0-9a-f-]{36}$/)).toHaveLength(2); // Mona is in two threads
    await u.click(screen.getByTestId('messages-unread-only'));
    await waitFor(() => expect(screen.getAllByTestId(/^thread-[0-9a-f-]{36}$/).length).toBeGreaterThan(0));
    for (const r of screen.getAllByTestId(/^thread-[0-9a-f-]{36}$/)) expect(r).toHaveAttribute('data-unread', 'true');
  });

  it('starts a thread with my manager from the contacts list, and an admin picks anyone', async () => {
    await signIn('reviewer');
    const u = userEvent.setup();
    const { unmount } = messagesAt();
    await u.click(await screen.findByTestId('messages-new'));
    const dlg = await screen.findByTestId('new-message');
    await waitFor(() => expect(within(dlg).getByTestId('new-message-opt-1001')).toBeInTheDocument()); // my manager
    expect(within(dlg).getByTestId('new-message-opt-1103')).toBeInTheDocument(); // my report
    expect(within(dlg).queryByTestId('new-message-opt-1204')).toBeNull(); // not my contact
    expect(screen.getByTestId('new-message-submit')).toBeDisabled();
    await u.selectOptions(within(dlg).getByTestId('new-message-to'), uid('1001'));
    await u.type(within(dlg).getByTestId('new-message-subject'), 'Leave plan');
    await u.type(within(dlg).getByTestId('new-message-body'), 'I will be away on Sunday.');
    await u.click(screen.getByTestId('new-message-submit'));
    await waitFor(async () => expect((await api.get<{ items: { subject: string }[] }>('/messages/threads')).items[0].subject).toBe('Leave plan'));
    unmount();

    // a refused recipient
    await expect(api.post('/messages/threads', { body: { to_user_id: uid('1204'), subject: 'Hi', body: 'x' } })).rejects.toMatchObject({ status: 403 });

    await signIn('pm');
    messagesAt();
    await u.click(await screen.findByTestId('messages-new'));
    const d2 = await screen.findByTestId('new-message');
    await waitFor(() => expect(within(d2).getByTestId('new-message-picker')).toBeInTheDocument());
    expect(within(d2).queryByTestId('new-message-to')).toBeNull();
  });

  it('only the two participants can read a thread', async () => {
    await signIn('engineer');
    await expect(api.get(`/messages/threads/${T1}`)).rejects.toMatchObject({ status: 404 });
    await signIn('pm');
    await expect(api.get(`/messages/threads/${T1}`)).rejects.toMatchObject({ status: 404 }); // not even the admin
  });
});

describe('announcement pop-up', () => {
  it('cannot be dismissed, and a disagreement needs a note', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    renderApp(<><AnnouncementPopup /><button data-testid="behind">behind</button></>);
    const pop = await screen.findByTestId('ann-popup');
    expect(within(pop).getByTestId('ann-popup-title')).toHaveTextContent('Updated site access rules');
    expect(pop).toHaveTextContent('Ahmed Salem');
    expect(within(pop).getByTestId('ann-popup-body')).toHaveTextContent('access permit number');
    expect(within(pop).queryByRole('button', { name: /close/i })).toBeNull();
    // Escape and a click outside do nothing
    await u.keyboard('{Escape}');
    fireEvent.pointerDown(document.body); fireEvent.mouseDown(document.body); fireEvent.click(document.body);
    expect(screen.getByTestId('ann-popup')).toBeInTheDocument();
    // the rest of the page is inert
    expect(screen.getByTestId('behind').closest('[aria-hidden="true"]')).not.toBeNull();

    await u.click(screen.getByTestId('ann-popup-disagree'));
    const send = screen.getByTestId('ann-popup-submit');
    expect(send).toBeDisabled();
    await u.type(screen.getByTestId('ann-popup-note'), 'no');
    expect(send).toBeDisabled();
    await u.type(screen.getByTestId('ann-popup-note'), 'pe');
    expect(send).toBeEnabled();
    await u.click(send);
    await waitFor(() => expect(screen.queryByTestId('ann-popup')).toBeNull());
    // recorded for the sender
    await signIn('pm');
    const rows = await api.get<{ items: { user: { employee_id: string }; decision: string; note: string }[] }>(`/announcements/${A1}/responses`, { query: { decision: 'disagree' } });
    expect(rows.items.find((r) => r.user.employee_id === '1204')).toMatchObject({ decision: 'disagree', note: 'nope' });
  });

  it('shows the next announcement after an answer, oldest first, and an agree needs no note', async () => {
    await signIn('pm');
    await api.post('/announcements', { body: { title: 'Second notice', body: 'Line one\nLine two', audience: { all: true } } });
    await signIn('engineer');
    const u = userEvent.setup();
    renderApp(<AnnouncementPopup />);
    expect(await screen.findByTestId('ann-popup-title')).toHaveTextContent('Updated site access rules');
    expect(screen.getByTestId('ann-popup-more')).toHaveTextContent('1');
    await u.click(screen.getByTestId('ann-popup-agree'));
    await waitFor(() => expect(screen.getByTestId('ann-popup-title')).toHaveTextContent('Second notice'));
    expect(screen.getByTestId('ann-popup-body').className).toContain('whitespace-pre-wrap');
    await u.click(screen.getByTestId('ann-popup-agree'));
    await waitFor(() => expect(screen.queryByTestId('ann-popup')).toBeNull());
  });

  it('keeps the announcement and shows a message when the server answers note_required', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    server.use(http.post(`${API_BASE}/announcements/:id/respond`, () => problemJson(422, 'note_required', [{ path: '/note', code: 'required' }])));
    renderApp(<AnnouncementPopup />);
    await u.click(await screen.findByTestId('ann-popup-disagree'));
    await u.type(screen.getByTestId('ann-popup-note'), 'Not workable');
    await u.click(screen.getByTestId('ann-popup-submit'));
    expect(await screen.findByTestId('ann-popup-error')).toBeInTheDocument();
    expect(screen.getByTestId('ann-popup')).toBeInTheDocument();
    expect(screen.getByTestId('ann-popup-note')).toHaveValue('Not workable');
  });

  it('polls with X-PMIS-Live, and shows for a pending-assignment account too', async () => {
    await signIn('pending');
    const seen: (string | null)[] = [];
    server.use(http.get(`${API_BASE}/me/announcements/pending`, ({ request }) => {
      seen.push(request.headers.get('X-PMIS-Live'));
      return HttpResponse.json({ items: [{ id: A1, title: 'For everyone', body: 'Body', created_at: '2026-10-27T08:00:00Z', created_by: { id: uid('1001'), display_name: 'Ahmed Salem', employee_id: '1001' } }] });
    }));
    renderApp(<App />, { route: '/' });
    expect(await screen.findByTestId('ann-popup')).toBeInTheDocument();
    expect(seen[0]).toBe('1');
    await act(async () => {});
  });
});

describe('announcements (sender)', () => {
  it('needs a title, a text and an audience, warns that recipients are fixed, and explains no_recipients', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Announcements />);
    await u.click(await screen.findByTestId('ann-new-open'));
    const dlg = await screen.findByTestId('ann-new');
    expect(within(dlg).getByTestId('ann-warning')).toHaveTextContent(/fixed/i);
    expect(within(dlg).getByTestId('ann-warning')).toHaveTextContent(/pop-up/i);
    const send = screen.getByTestId('ann-new-submit');
    expect(send).toBeDisabled();
    await u.type(within(dlg).getByTestId('ann-title'), 'Fire drill');
    await u.type(within(dlg).getByTestId('ann-body'), 'Friday at 10.');
    expect(send).toBeDisabled(); // no audience yet
    expect(within(dlg).getByTestId('ann-audience-hint')).toBeInTheDocument();
    // yourself is never a recipient: nobody matches
    await u.type(within(dlg).getByTestId('ann-users-search'), 'Ahmed');
    await u.click(await within(dlg).findByTestId('ann-users-opt-1001'));
    expect(send).toBeEnabled();
    await u.click(send);
    expect(await within(dlg).findByTestId('ann-new-error')).toHaveTextContent(/nobody matches/i);
    // choose a department instead
    await u.click(within(dlg).getByTestId('ann-users-chip-1001').querySelector('button')!);
    await u.click(await within(dlg).findByTestId('ann-dept-CIVIL'));
    await u.click(send);
    await waitFor(() => expect(screen.queryByTestId('ann-new')).toBeNull());
    const row = await screen.findByText('Fire drill');
    const tr = row.closest('tr')!;
    expect(within(tr).getByTestId(/ann-count-.*-recipients/)).toHaveTextContent('8'); // active people of Civil Works: 1210 and 1211 are pending assignment
    expect(within(tr).getByTestId(/ann-count-.*-pending/)).toHaveTextContent('8');
  });

  it('"Everyone" hides the other pickers', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Announcements />);
    await u.click(await screen.findByTestId('ann-new-open'));
    const dlg = await screen.findByTestId('ann-new');
    expect(within(dlg).getByTestId('ann-groups')).toBeInTheDocument();
    await u.click(within(dlg).getByTestId('ann-all'));
    expect(within(dlg).queryByTestId('ann-groups')).toBeNull();
    await u.type(within(dlg).getByTestId('ann-title'), 'All hands');
    await u.type(within(dlg).getByTestId('ann-body'), 'Monday 9:00');
    expect(screen.getByTestId('ann-new-submit')).toBeEnabled();
  });

  it('shows the audience, the counts, the answers with notes, a decision filter and an export', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/announcements/:id" element={<AnnouncementResults />} /></Routes>, { route: `/admin/announcements/${A1}` });
    expect(await screen.findByTestId('ann-detail-title')).toHaveTextContent('Updated site access rules');
    expect(screen.getByTestId('ann-audience')).toHaveTextContent('Everyone');
    await waitFor(() => expect(screen.getByTestId('ann-stat-pending')).toHaveTextContent('2'));
    expect(screen.getByTestId('ann-stat-disagree')).toHaveTextContent('1');
    expect(await screen.findByTestId('ann-resp-note-1306')).toHaveTextContent('night shift');
    expect(screen.getByTestId('ann-resp-decision-1204')).toHaveTextContent('Pending');
    await u.selectOptions(screen.getByTestId('ann-filter'), 'pending');
    await waitFor(() => expect(screen.getAllByTestId(/^ann-resp-\d{4}$/)).toHaveLength(2));
    await u.selectOptions(screen.getByTestId('ann-filter'), 'disagree');
    await waitFor(() => expect(screen.getAllByTestId(/^ann-resp-\d{4}$/)).toHaveLength(1));
    await u.click(screen.getByTestId('ann-export'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('announcement-99000000-responses.csv'));
  });

  it('keeps results from people who are not the sender or an admin', async () => {
    await signIn('reviewer');
    await expect(api.get(`/announcements/${A1}/responses`)).rejects.toMatchObject({ status: 404 });
    await expect(api.post('/announcements', { body: { title: 'x', body: 'y', audience: { all: true } } })).rejects.toMatchObject({ status: 403 });
  });

  it('answers once, and fixes the recipients at send time', async () => {
    await signIn('pm');
    const sent = await api.post<{ id: string; recipient_count: number }>('/announcements', { body: { title: 'T', body: 'B', audience: { all: true } } });
    await signIn('engineer');
    await api.post(`/announcements/${sent.id}/respond`, { body: { decision: 'agree' } });
    await expect(api.post(`/announcements/${sent.id}/respond`, { body: { decision: 'agree' } })).rejects.toMatchObject({ status: 409 });
    await expect(api.post(`/announcements/${A1}/respond`, { body: { decision: 'disagree', note: ' x ' } })).rejects.toMatchObject({ status: 422, code: 'note_required' });
    await signIn('pm');
    // somebody who joins later is not a recipient
    const rows = await api.get<{ items: unknown[] }>(`/announcements/${sent.id}/responses`);
    expect(rows.items).toHaveLength(sent.recipient_count);
  });
});

describe('departments and manager', () => {
  it('has a Departments sub-tab under Users: list, create, deactivate with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Users />);
    expect(await screen.findByTestId('user-dept-1103')).toHaveTextContent('RF & Design'); // department column
    expect(screen.getAllByRole('tab').map((x) => x.getAttribute('data-testid'))).toEqual(['users-tab-active', 'users-tab-deleted', 'users-tab-departments', 'users-tab-online']);
    await u.click(screen.getByTestId('users-tab-departments'));
    expect(await screen.findByTestId('dept-row-CIVIL')).toHaveTextContent('Civil Works');
    expect(screen.getByTestId('dept-status-LEGACY')).toHaveTextContent('Inactive');

    await u.click(screen.getByTestId('dept-new'));
    await u.type(screen.getByTestId('dept-code'), 'q');
    expect(screen.getByTestId('dept-dialog-submit')).toBeDisabled(); // code needs 2 to 20 characters
    await u.type(screen.getByTestId('dept-code'), 'a');
    await u.type(screen.getByTestId('dept-name-en'), 'Quality Assurance');
    await u.click(screen.getByTestId('dept-dialog-submit')); // reason is mandatory
    expect(await screen.findByTestId('dept-dialog-reason-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('dept-dialog-reason'), 'New team');
    await u.click(screen.getByTestId('dept-dialog-submit'));
    expect(await screen.findByTestId('dept-row-QA')).toHaveTextContent('Quality Assurance');

    // a duplicate code is refused
    await u.click(screen.getByTestId('dept-new'));
    await u.type(screen.getByTestId('dept-code'), 'qa');
    await u.type(screen.getByTestId('dept-name-en'), 'Again');
    await u.type(screen.getByTestId('dept-dialog-reason'), 'Duplicate try');
    await u.click(screen.getByTestId('dept-dialog-submit'));
    expect(await screen.findByTestId('dept-dialog-error')).toBeInTheDocument();
    await u.click(within(screen.getByTestId('dept-dialog')).getByText('Cancel'));

    await u.click(screen.getByTestId('dept-toggle-QA'));
    await u.type(screen.getByTestId('dept-dialog-reason'), 'Merged elsewhere');
    await u.click(screen.getByTestId('dept-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('dept-status-QA')).toHaveTextContent('Inactive'));
  });

  it('only the admin sees inactive departments, and an inactive one cannot be chosen for a person', async () => {
    await signIn('reviewer');
    const names = (await api.get<{ items: { code: string }[] }>('/departments', { query: { include_inactive: true } })).items.map((d) => d.code);
    expect(names).not.toContain('LEGACY');
    await signIn('pm'); await stepUpDone();
    await expect(api.put(`/users/${uid('1103')}/org`, { body: { manager_id: null, department_id: (await api.get<{ items: { id: string; code: string }[] }>('/departments', { query: { include_inactive: true } })).items.find((d) => d.code === 'LEGACY')!.id, reason: 'try' } })).rejects.toMatchObject({ status: 422 });
  });

  it('shows manager and department on the user page and edits them in a dialog; a loop is refused', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1103')}` });
    const mgr = await screen.findByTestId('org-manager-value');
    await waitFor(() => expect(mgr).toHaveTextContent('Mona Fathi'));
    expect(mgr).toHaveTextContent('1102');
    expect(screen.getByTestId('org-department-value')).toHaveTextContent('RF & Design');

    await u.click(screen.getByTestId('org-edit'));
    const dlg = await screen.findByTestId('org-dialog');
    await u.selectOptions(within(dlg).getByTestId('org-department'), await within(dlg).findByRole('option', { name: 'Warehouse' }));
    await u.click(within(dlg).getByTestId('org-manager-chip-1102').querySelector('button')!);
    await u.type(within(dlg).getByTestId('org-manager-search'), 'Omar');
    await u.click(await within(dlg).findByTestId('org-manager-opt-1203'));
    await u.click(screen.getByTestId('org-dialog-submit')); // reason first
    expect(await screen.findByTestId('org-dialog-reason-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('org-dialog-reason'), 'Moved teams');
    await u.click(screen.getByTestId('org-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('org-dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('org-manager-value')).toHaveTextContent('Omar Khaled'));
    expect(screen.getByTestId('org-department-value')).toHaveTextContent('Warehouse');

    // Mona (1102) reports to the PM; making her report to Ali (1103), who now reports to Omar -> the PM is above Omar, no loop. Make Omar report to Ali: loop.
    await expect(api.put(`/users/${uid('1203')}/org`, { body: { manager_id: uid('1103'), department_id: null, reason: 'try' } })).rejects.toMatchObject({ status: 422, problem: { errors: [{ code: 'manager_loop' }] } });
  });

  it('maps manager_loop to a clear message in the dialog and rolls the page back', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/users/:userId" element={<UserDetailPage />} /></Routes>, { route: `/admin/users/${uid('1102')}` });
    await waitFor(() => expect(screen.getByTestId('org-manager-value')).toHaveTextContent('Ahmed Salem'));
    await u.click(screen.getByTestId('org-edit'));
    const dlg = await screen.findByTestId('org-dialog');
    await u.click(within(dlg).getByTestId('org-manager-chip-1001').querySelector('button')!);
    await u.type(within(dlg).getByTestId('org-manager-search'), 'Ali');
    await u.click(await within(dlg).findByTestId('org-manager-opt-1103')); // Ali reports to Mona: a loop
    await u.type(screen.getByTestId('org-dialog-reason'), 'Reorganisation');
    await u.click(screen.getByTestId('org-dialog-submit'));
    expect(await screen.findByTestId('org-dialog-error')).toHaveTextContent(/report to this person/i);
    await waitFor(() => expect(screen.getByTestId('org-manager-value')).toHaveTextContent('Ahmed Salem')); // back to the old manager
    // a person cannot be their own manager
    await u.clear(within(dlg).getByTestId('org-manager-search'));
    await u.type(within(dlg).getByTestId('org-manager-search'), 'Mona');
    expect(await within(dlg).findByTestId('org-manager-opt-1102')).toBeDisabled();
  });
});
