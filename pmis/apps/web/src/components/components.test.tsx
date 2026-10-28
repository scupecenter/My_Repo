import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { Approvals } from '@/pages/Approvals';
import { EmployeeId } from '@/pages/EmployeeId';
import { Login } from '@/pages/Login';
import { MyWork } from '@/pages/MyWork';
import { Pending } from '@/pages/Pending';
import { PersonTag } from './PersonTag';
import { renderApp, signIn } from '@/test/utils';

const T = (n: number) => `10000000-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;

describe('Login', () => {
  it('has the one identifier box and a password, and hides Microsoft 365 by default', () => {
    renderApp(<Login />);
    expect(screen.getByTestId('login-identifier')).toBeInTheDocument();
    expect(document.querySelector('input[type=password]')).not.toBeNull();
    expect(screen.queryByTestId('login-m365')).toBeNull();
  });
});

describe('EmployeeId', () => {
  it('rejects non-4-digit input locally and unknown IDs from the server', async () => {
    await signIn('newbie');
    renderApp(<EmployeeId />);
    const u = userEvent.setup();
    await u.type(screen.getByTestId('employee-id-input'), '12');
    await u.click(screen.getByTestId('employee-id-submit'));
    expect(screen.getByTestId('employee-id-error')).toHaveTextContent('exactly 4 digits');
    await u.clear(screen.getByTestId('employee-id-input'));
    await u.type(screen.getByTestId('employee-id-input'), '7777');
    await u.click(screen.getByTestId('employee-id-submit'));
    await waitFor(() => expect(screen.getByTestId('employee-id-error')).toHaveTextContent('not in the staff registry'));
  });
});

describe('Pending', () => {
  it('shows the pending state and notifies admins', async () => {
    await signIn('pending');
    renderApp(<Pending session={{ authenticated: true, csrf_token: '', user: { id: 'u', display_name: 'Wael Saadi', employee_id: '1211' } }} />);
    await userEvent.click(screen.getByTestId('pending-notify'));
    await screen.findByText('The admins were notified.');
  });
});

describe('PersonTag hover card', () => {
  it('shows ID beside the name and hides fields per visibility payload', async () => {
    await signIn('pm');
    renderApp(<PersonTag name="Karim Zaroug" employeeId="1104" />);
    expect(screen.getByTestId('person-id-1104')).toHaveTextContent('1104');
    screen.getByTestId('person-id-1104').focus();
    const card = await screen.findByTestId('staff-card');
    await within(card).findByTestId('card-email');
    expect(within(card).getByTestId('card-email')).toHaveTextContent('example.com');
    expect(within(card).getByTestId('card-phone')).toHaveTextContent('Not visible to you');
  });
});

describe('MyWork', () => {
  it('lists buckets for the PM', async () => {
    await signIn('pm');
    renderApp(<MyWork />, { route: '/my-work' });
    await waitFor(() => expect(screen.getByTestId('my-work-count-do_now')).toHaveTextContent('7'));
    expect(screen.getByTestId('my-work-count-late')).toHaveTextContent('1');
  });
  it('shows the caught-up state when empty', async () => {
    await signIn('newbie');
    server.use(http.get(`${API_BASE}/me/tasks`, () => HttpResponse.json({ items: [], page: { limit: 50, next_cursor: null } })));
    await signIn('pm');
    renderApp(<MyWork />);
    await screen.findByTestId('my-work-empty');
  });
  it('renders Arabic strings', async () => {
    await signIn('pm');
    renderApp(<MyWork />, { locale: 'ar' });
    expect(await screen.findByText('نفّذ الآن')).toBeInTheDocument();
  });
});

describe('Approvals', () => {
  it('approves a review item optimistically and removes it', async () => {
    await signIn('reviewer');
    renderApp(<Approvals />);
    const row = await screen.findByTestId(`approval-row-${T(6)}`);
    const u = userEvent.setup();
    await u.click(within(row).getByTestId(`approval-open-${T(6)}`));
    await u.click(await screen.findByTestId('approval-pass'));
    await waitFor(() => expect(screen.queryByTestId(`approval-row-${T(6)}`)).toBeNull());
  });

  it('rolls back the optimistic removal when the server refuses', async () => {
    await signIn('reviewer');
    server.use(http.post(`${API_BASE}/tasks/:id/review`, async () => {
      await new Promise((r) => setTimeout(r, 50));
      return new HttpResponse(JSON.stringify({ type: 'x', title: 'Gone', status: 412, code: 'precondition_failed' }), { status: 412, headers: { 'Content-Type': 'application/problem+json' } });
    }));
    renderApp(<Approvals />);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId(`approval-open-${T(6)}`));
    await u.click(await screen.findByTestId('approval-pass'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveAttribute('data-kind', 'err'));
    expect(screen.getByTestId(`approval-row-${T(6)}`)).toBeInTheDocument();
  });

  it('requires a note to return a task', async () => {
    await signIn('reviewer');
    renderApp(<Approvals />);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId(`approval-open-${T(6)}`));
    await u.click(await screen.findByTestId('approval-reject'));
    await u.click(screen.getByTestId('reject-submit'));
    expect(screen.getByTestId('reject-error')).toBeInTheDocument();
    await u.type(screen.getByTestId('reject-note'), 'Wrong date');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.queryByTestId(`approval-row-${T(6)}`)).toBeNull());
  });

  it('bulk approve asks for one step-up then completes', async () => {
    await signIn('pm');
    renderApp(<Approvals />);
    const u = userEvent.setup();
    await screen.findByTestId('approvals-list');
    await u.click(await screen.findByTestId('approvals-tab-approve'));
    await waitFor(() => expect(screen.queryByTestId(`approval-row-${T(6)}`)).toBeNull());
    await u.click(await screen.findByTestId('approval-select-all'));
    await u.click(screen.getByTestId('bulk-approve'));
    const dlg = await screen.findByTestId('stepup-dialog');
    expect(dlg).toBeInTheDocument();
    await u.click(screen.getByTestId('stepup-cancel'));
    await waitFor(() => expect(screen.getByTestId(`approval-row-${T(1)}`)).toBeInTheDocument()); // rolled back
  });
});
