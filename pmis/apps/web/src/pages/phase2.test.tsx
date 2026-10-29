import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { api, API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { siteIdOf, taskIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { MatrixPage } from './Matrix';
import { Site } from './Site';
import { Sites } from './Sites';
import { Route, Routes } from 'react-router-dom';
import type { TaskDetail } from '@/api/types';

const SITE = siteIdOf(0), A1 = taskIdOf(0, 0), A2 = taskIdOf(0, 1);
const siteRoute = (q = '') => ({ route: `/sites/${SITE}${q}` });
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
const file = () => new File(['%PDF-1.4'], 'sar.pdf', { type: 'application/pdf' });

async function submitA1AsReviewer() {
  await signIn('reviewer');
  const t0 = await api.get<TaskDetail>(`/tasks/${A1}`);
  await api.patch(`/tasks/${A1}`, { version: t0.version, body: { actual_date: '2026-10-20' } }); // the engine needs the actual date to submit
  await api.post(`/tasks/${A1}/slots/${t0.slots[0].id}/files`, { body: (() => { const f = new FormData(); f.append('file', file()); return f; })() });
  const t1 = await api.get<TaskDetail>(`/tasks/${A1}`);
  await api.post(`/tasks/${A1}/submit`, { version: t1.version });
}

describe('Sites list', () => {
  it('virtualises rows and filters by region', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites' });
    await waitFor(() => expect(screen.getByTestId('sites-count')).toHaveTextContent('150'));
    expect(screen.getAllByRole('listitem').length).toBeLessThan(40);
    expect(screen.getAllByTestId('mini-rail').length).toBeGreaterThan(0);
    await userEvent.selectOptions(screen.getByTestId('sites-filter-region'), '1');
    await waitFor(() => expect(Number(screen.getByTestId('sites-count').textContent?.match(/\d+/)?.[0])).toBeLessThan(40));
    await userEvent.type(screen.getByTestId('sites-search'), 'zzzz');
    await waitFor(() => expect(screen.getByTestId('sites-empty')).toBeInTheDocument());
  });
});

describe('Task grid', () => {
  it('edits a date inline by keyboard and click, with Esc cancelling', async () => {
    await signIn('reviewer');
    renderApp(<SiteAt />, siteRoute());
    await screen.findByTestId(`grid-cell-${A1}-actual`);
    expect(screen.getByTestId('pipeline')).toBeInTheDocument();
    expect(screen.getByTestId('cluster-progress')).toBeInTheDocument();
    // holders carry employee IDs
    expect(within(screen.getByTestId(`grid-row-${A1}`)).getAllByTestId(/^person-id-/).length).toBeGreaterThan(0);

    const body = screen.getByTestId('task-grid-body');
    body.focus();
    const u = userEvent.setup();
    await u.keyboard('{ArrowDown}{ArrowRight}{ArrowRight}{Enter}'); // row A1, actual column
    const input = await screen.findByTestId(`grid-input-${A1}-actual`);
    await u.keyboard('{Escape}');
    expect(screen.queryByTestId(`grid-input-${A1}-actual`)).toBeNull();
    expect(input).not.toBeInTheDocument();

    await u.click(screen.getByTestId(`grid-cell-${A1}-actual`));
    const input2 = await screen.findByTestId(`grid-input-${A1}-actual`);
    await u.type(input2, '2026-10-20{Enter}');
    await waitFor(() => expect(screen.getByTestId(`grid-cell-${A1}-actual`)).toHaveTextContent('2026-10-20'));
    await waitFor(async () => expect((await api.get<TaskDetail>(`/tasks/${A1}`)).actual_date).toBe('2026-10-20'));
  });

  it('rolls the date back when the server refuses', async () => {
    await signIn('reviewer');
    server.use(http.patch(`${API_BASE}/tasks/:id`, () => HttpResponse.json({ type: 'x', title: 'no', status: 403, code: 'forbidden' }, { status: 403, headers: { 'Content-Type': 'application/problem+json' } })));
    renderApp(<SiteAt />, siteRoute());
    const u = userEvent.setup();
    await u.click(await screen.findByTestId(`grid-cell-${A1}-plan`));
    const before = (await screen.findByTestId(`grid-input-${A1}-plan`) as HTMLInputElement).value;
    await u.clear(screen.getByTestId(`grid-input-${A1}-plan`));
    await u.type(screen.getByTestId(`grid-input-${A1}-plan`), '2030-01-01{Enter}');
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveAttribute('data-kind', 'err'));
    await waitFor(() => expect(screen.getByTestId(`grid-cell-${A1}-plan`)).toHaveTextContent(before));
  });

  it('offers a per-task template download and explains a lock', async () => {
    await signIn('reviewer');
    let asked = '';
    server.use(http.get(`${API_BASE}/templates/:id/download`, ({ request }) => { asked = new URL(request.url).searchParams.get('task_id') ?? ''; return new HttpResponse(new Uint8Array([1]), { headers: { 'Content-Disposition': 'attachment; filename="x.xlsx"' } }); }));
    renderApp(<SiteAt />, siteRoute());
    await userEvent.click(await screen.findByTestId(`task-template-download-${A1}`));
    await waitFor(() => expect(asked).toBe(A1));
    await userEvent.click(screen.getByTestId(`why-locked-${A2}`));
    expect(await screen.findByTestId('why-locked-card')).toHaveTextContent(/approved first/);
  });

  it('opens the drawer from a row', async () => {
    await signIn('reviewer');
    renderApp(<SiteAt />, siteRoute());
    await userEvent.click(await screen.findByTestId(`grid-open-${A1}`));
    expect(await screen.findByTestId('task-drawer')).toBeInTheDocument();
  });
});

describe('Task drawer', () => {
  it('keeps Submit disabled until the mandatory slot is filled, then submits (skip of own level)', async () => {
    await signIn('reviewer');
    renderApp(<SiteAt />, siteRoute(`?task=${A1}`));
    const submit = await screen.findByTestId('drawer-submit');
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('drawer-skip-note')).toBeInTheDocument();
    const slot = (await screen.findAllByTestId(/^slot-input-/))[0];
    await userEvent.upload(slot, file());
    await waitFor(() => expect(screen.getByTestId('drawer-submit')).toBeEnabled());
    // submitting without the actual date is refused in plain words (422 mandatory_fields_missing), nothing changes
    await userEvent.click(screen.getByTestId('drawer-submit'));
    expect(await screen.findByText('Fill the mandatory fields first: actual_date.')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-state')).toHaveTextContent('Entry');
    // save the date (If-Match), then submit
    fireEvent.change(screen.getByTestId('drawer-actual-date'), { target: { value: '2026-10-20' } });
    await userEvent.click(screen.getByTestId('drawer-save'));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('drawer-submit'));
    await waitFor(() => expect(screen.getByTestId('drawer-state')).toHaveTextContent('Awaiting approval'));
    await waitFor(() => expect(screen.getByTestId('history-list')).toHaveTextContent(/Auto-skipped/));
  });

  it('requires a note to reject and asks for step-up on final approve', async () => {
    await submitA1AsReviewer();
    await signIn('pm');
    renderApp(<SiteAt />, siteRoute(`?task=${A1}`));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('drawer-reject'));
    await u.click(await screen.findByTestId('reject-submit'));
    expect(screen.getByTestId('reject-error')).toBeInTheDocument();
    await u.click(screen.getByText('Cancel'));
    await u.click(screen.getByTestId('drawer-approve'));
    expect(await screen.findByTestId('stepup-dialog')).toBeInTheDocument();
    await u.click(screen.getByTestId('stepup-cancel'));
    await waitFor(() => expect(screen.getByTestId('drawer-state')).toHaveTextContent('Awaiting approval'));
  });

  it('returns the task with a note', async () => {
    await submitA1AsReviewer();
    await signIn('pm');
    renderApp(<SiteAt />, siteRoute(`?task=${A1}`));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('drawer-reject'));
    await u.type(await screen.findByTestId('reject-note'), 'Wrong date');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.getByTestId('drawer-state')).toHaveTextContent('Entry'));
    await waitFor(() => expect(screen.getByTestId('comment-list')).toHaveTextContent('Wrong date'));
  });
});

describe('Responsibility Matrix', () => {
  it('lists stage, register and Dismantle rows with skip preview', async () => {
    await signIn('pm');
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    await screen.findByTestId('matrix-row-site_release');
    expect(screen.getByTestId('matrix-row-dismantle')).toBeInTheDocument();
    expect(screen.getByTestId('matrix-row-procurement')).toBeInTheDocument();
    expect(screen.getByTestId('matrix-skip-site_release')).toHaveTextContent('Mona Fathi');
    expect(screen.getByTestId('matrix-skip-final_closure')).toHaveTextContent(/final approval/);
  });

  it('edits a cell and publishes after re-authentication', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    const u = userEvent.setup();
    const cell = await screen.findByTestId('matrix-cell-pre_cw-1');
    await u.click(within(cell).getByTestId('matrix-add'));
    await u.type(await screen.findByTestId('matrix-picker-q'), 'Hana');
    await u.click(await screen.findByTestId('matrix-opt-user-1210'));
    expect(within(screen.getByTestId('matrix-cell-pre_cw-1')).getByTestId('person-id-1210')).toBeInTheDocument();
    await u.click(screen.getByTestId('matrix-all-pre_cw-1'));
    expect(screen.getByTestId('matrix-dirty')).toHaveTextContent('1');
    await u.click(screen.getByTestId('matrix-publish'));
    await u.type(screen.getByTestId('matrix-reason'), 'Cover Middle');
    await u.click(screen.getByTestId('matrix-publish-confirm'));
    await waitFor(() => expect(screen.getByTestId('matrix-dirty')).toHaveTextContent('0'));
    expect((await api.get<{ stages: { code: string; cells: { level: number; rule: string; assignees: unknown[] }[] }[] }>('/matrix')).stages.find((s) => s.code === 'pre_cw')!.cells[0]).toMatchObject({ rule: 'all_members' });
  });

  it('refuses an empty used level and keeps the server copy', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    const u = userEvent.setup();
    const cell = await screen.findByTestId('matrix-cell-site_release-3');
    await u.click(within(cell).getByTestId(/^holder-remove-/));
    await u.click(screen.getByTestId('matrix-publish'));
    await u.type(screen.getByTestId('matrix-reason'), 'Test empty');
    await u.click(screen.getByTestId('matrix-publish-confirm'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveAttribute('data-kind', 'err'));
    // the server copy is untouched; the draft stays on screen so the admin can fix it
    expect(screen.getByTestId('matrix-dirty')).toHaveTextContent('1');
    expect((await api.get<{ stages: { code: string; cells: { level: number; assignees: unknown[] }[] }[] }>('/matrix')).stages.find((x) => x.code === 'site_release')!.cells.find((c) => c.level === 3)!.assignees).toHaveLength(1);
  });
});
