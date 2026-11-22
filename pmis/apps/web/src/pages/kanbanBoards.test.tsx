import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { intentFor } from '@/components/TasksBoard';
import { wipState } from '@/mocks/handlers.boards';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { MyWork } from './MyWork';
import { Sites } from './Sites';
import { SettingsRoutes } from './settings/Settings';

/**
 * F5 (contract 0.15.32): the SITE 360 board by milestone (read only, swimlanes, ageing, WIP warning) and the tasks board of My Work, where a
 * drop or the keyboard "Open action" menu only opens the task's existing action, and is refused when the server does not offer it.
 */
const T = 30_000;
const TASK_APPROVE = '10000000-0000-4000-8000-000000000001'; // mock: in approval, the PM approves it
const TASK_REVIEW = '10000000-0000-4000-8000-000000000006'; // mock: in review

/** Every write the page sends (method + path); the boards must send none on their own. */
function writes(): string[] {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => { if (request.method !== 'GET') seen.push(`${request.method} ${new URL(request.url).pathname}`); });
  return seen;
}

describe('sites board (SITE 360)', () => {
  it('shows a column per milestone and Closed, cards as links (no drag), ageing in working days, and the same filters as the list', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.use(http.get(`${API_BASE}/boards/sites`, ({ request }) => { seen.push(new URL(request.url).search); }));
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?layout=list&region_id=1' });
    await u.click(await screen.findByTestId('sites-layout-board'));
    const board = await screen.findByTestId('sites-board');
    await within(board).findByTestId('board-col-site_release');
    expect(within(board).getByTestId('board-col-closed')).toHaveTextContent('Closed');
    await waitFor(() => expect(seen.some((s) => s.includes('region_id=1'))).toBe(true));
    const card = within(board).getAllByRole('link')[0]!;
    expect(card.getAttribute('href')).toMatch(/^\/sites\/[0-9a-f-]+$/);
    expect(card).not.toHaveAttribute('draggable', 'true');
    expect(within(card).getByText(/working day/)).toBeInTheDocument();
    // keyboard: the cards are links in the tab order
    card.focus();
    expect(card).toHaveFocus();
    // swimlanes by region
    await u.selectOptions(screen.getByTestId('sites-board-swimlane'), 'region');
    await screen.findByTestId('board-lane-title-1');
    await waitFor(() => expect(seen.some((s) => s.includes('swimlane=region'))).toBe(true));
  }, T);

  it('marks a column above its WIP limit with a warning and keeps every card (Arabic)', async () => {
    await signIn('pm');
    wipState.limits = { site_release: 1 };
    try {
      renderApp(<Sites />, { route: '/sites?layout=board', locale: 'ar' });
      const col = await screen.findByTestId('board-col-site_release');
      await waitFor(() => expect(col).toHaveAttribute('data-over-wip', 'true'));
      expect(within(col).getByTestId('board-col-wip-site_release')).toHaveTextContent('فوق حد العمل الجاري');
      expect(within(col).getByRole('note')).toBeInTheDocument();
      expect(screen.getByTestId('sites-board-swimlane')).toBeInTheDocument();
      expect(screen.getByTestId('sites-board')).toHaveAttribute('aria-label', 'لوحة المواقع حسب المعلم');
      expect(within(col).getByText('إطلاق الموقع')).toBeInTheDocument();
    } finally {
      wipState.limits = {};
    }
  }, T);

  it('Settings, Workflow, Board: the WIP limits are saved with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/workflow/board' });
    expect(await screen.findByTestId('settings-section-workflow-board')).toHaveTextContent('Board WIP limits');
    const input = await screen.findByTestId('wip-pre_cw');
    expect(input).toHaveAttribute('placeholder', 'No limit');
    await u.type(input, '25');
    await u.click(screen.getByTestId('wip-save'));
    const dlg = await screen.findByTestId('wip-dialog');
    await u.type(within(dlg).getByTestId('wip-dialog-reason'), 'Warn the CW leads above 25');
    await u.click(within(dlg).getByTestId('wip-dialog-submit'));
    await waitFor(() => expect(wipState.limits).toEqual({ pre_cw: 25 }));
    wipState.limits = {};
  }, T);
});

describe('tasks board (My Work)', () => {
  it('maps a target column to the existing action only', () => {
    expect(intentFor('review', [{ action: 'submit' }])).toBe('submit');
    expect(intentFor('approved', [{ action: 'approve' }, { action: 'reject' }])).toBe('approve');
    expect(intentFor('approved', [{ action: 'review', final: false }])).toBeNull();
    expect(intentFor('approved', [{ action: 'review', final: true }])).toBe('review');
    expect(intentFor('rejected', [{ action: 'approve' }, { action: 'reject' }])).toBe('reject');
    expect(intentFor('entry', [{ action: 'reject' }])).toBeNull();
    expect(intentFor('review', [{ action: 'comment' }])).toBeNull();
  });

  it('a drop on Approved opens the approve action in the drawer and changes nothing until confirmed', async () => {
    await signIn('pm');
    const sent = writes();
    renderApp(<MyWork />, { route: '/my-work?layout=board' });
    const card = await screen.findByTestId(`board-task-${TASK_APPROVE}`);
    expect(card).toHaveAttribute('data-column', 'review');
    const target = screen.getByTestId('board-tcol-approved');
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    const intent = await screen.findByTestId('drawer-intent');
    expect(intent).toHaveTextContent('approve');
    await waitFor(() => expect(screen.getByTestId('drawer-approve')).toHaveFocus());
    expect(sent).toEqual([]); // nothing was written: the approval is the existing button, pressed by the person
    expect(screen.getByTestId(`board-task-${TASK_APPROVE}`)).toHaveAttribute('data-column', 'review');
  }, T);

  it('keyboard: "Open action" to Rejected opens the reject dialog with its mandatory note (Arabic)', async () => {
    await signIn('pm');
    const sent = writes();
    const u = userEvent.setup();
    renderApp(<MyWork />, { route: '/my-work?layout=board', locale: 'ar' });
    const menu = await screen.findByTestId(`board-task-move-${TASK_APPROVE}`);
    menu.focus();
    await u.selectOptions(menu, 'rejected');
    const dlg = await screen.findByTestId('reject-dialog');
    await u.click(within(dlg).getByTestId('reject-submit'));
    expect(await within(dlg).findByTestId('reject-error')).toBeInTheDocument(); // the note is mandatory
    expect(sent).toEqual([]);
  }, T);

  it('a drop the server does not allow is refused with a message and opens nothing', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<MyWork />, { route: '/my-work?layout=board' });
    // an in-review task cannot be "submitted" again: In review offers no action for it
    const menu = await screen.findByTestId(`board-task-move-${TASK_REVIEW}`);
    await u.selectOptions(menu, 'entry');
    expect(await screen.findByText(/You cannot do that here/)).toBeInTheDocument();
    expect(screen.queryByTestId('drawer-intent')).toBeNull();
    expect(screen.queryByTestId('reject-dialog')).toBeNull();
  }, T);
});
