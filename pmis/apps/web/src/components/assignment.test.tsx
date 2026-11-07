import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import type { RegisterRecord } from '@/api/types';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { Balance, ExtendBooking, MembersEditor, ReadinessBadge, VehiclePicker } from './AssignmentPanels';

const rec = (data: Record<string, unknown>) => ({ id: 'r1', data } as unknown as RegisterRecord);
const problem = (status: number, code: string) => HttpResponse.json({ type: 'x', title: code, status, code }, { status });

describe('Assignment panels (contract 0.15.0)', () => {
  it('edits members: role and single lead', async () => {
    let v: unknown = [{ user_id: 'a', member_role: 'executor', is_lead: true }, { user_id: 'b', member_role: 'executor' }];
    const { rerender } = renderApp(<MembersEditor value={v} onChange={(n) => { v = n; }} names={{ a: 'Amal', b: 'Bilal' }} />);
    await userEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(v).toEqual([{ user_id: 'a', member_role: 'executor', is_lead: false }, { user_id: 'b', member_role: 'executor', is_lead: true }]);
    rerender(<div />);
  });

  it('shows the readiness badge with ready_date', async () => {
    await signIn('pm');
    server.use(http.get(`${API_BASE}/registers/procurement/records/r1/readiness`, () => HttpResponse.json({ readiness: 'ready_to_mobilize', ready_date: '2026-11-09', approved: true })));
    renderApp(<ReadinessBadge recordId="r1" />);
    expect(await screen.findByTestId('reg-readiness')).toHaveAttribute('data-readiness', 'ready_to_mobilize');
    expect(screen.getByTestId('reg-ready-date')).toHaveTextContent('2026-11-09');
  });

  it('lists free vehicles for the dates and passes the filters', async () => {
    await signIn('pm');
    let url = '';
    server.use(http.get(`${API_BASE}/fleet/availability`, ({ request }) => { url = request.url; return HttpResponse.json({ items: [{ vehicle_id: 'v1', plate_no: 'LY-123', vehicle_type: 'pickup' }] }); }));
    renderApp(<VehiclePicker value="" onChange={() => undefined} from="2026-11-10" to="2026-11-12" vehicleType="pickup" />);
    expect(await screen.findByRole('option', { name: /LY-123/ })).toBeInTheDocument();
    expect(url).toContain('from=2026-11-10');
    expect(url).toContain('vehicle_type=pickup');
  });

  it('shows the 409 of an extension in plain words', async () => {
    await signIn('pm');
    server.use(http.post(`${API_BASE}/registers/car_dispatcher/records/r1/extend`, () => problem(409, 'vehicle_already_reserved')));
    renderApp(<ExtendBooking record={rec({})} onDone={() => undefined} />);
    await userEvent.type(screen.getByTestId('reg-extend-to'), '2026-11-20');
    await userEvent.click(screen.getByTestId('reg-extend'));
    await waitFor(() => expect(screen.getByTestId('reg-extend-error')).toHaveTextContent(/already reserved/i));
  });

  it('renders hidden, not 0, for masked amounts', () => {
    renderApp(<Balance record={rec({ amounts_hidden: true })} />);
    expect(screen.getByTestId('reg-balance')).toHaveTextContent('hidden');
    expect(screen.getByTestId('reg-balance')).not.toHaveTextContent('0');
  });
});
