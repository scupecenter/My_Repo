import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { forType, typeData, typeHides } from '@/lib/registerForms';
import { carDispatcher, contractors } from '@/mocks/registersData';
import { RegisterPage } from './Register';

/**
 * Audit 2026-11-17 (C X2 / X3, P0): the record drawer asks for the record type in every register that has types, also in the registers that are not
 * site-scoped (Contractors: company, team, contract; Car Dispatcher: vehicle, booking), and shows only the fields of the chosen type. EN and AR.
 */
const Routed = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;
const at = (key: string) => ({ route: `/registers/${key}` });

describe('the fields of a record type (registerForms)', () => {
  it('keeps the vehicle fields for a vehicle and the booking fields for a booking, and none before a type is chosen', () => {
    const codes = (rt: string) => forType(carDispatcher, rt).fields.map((f) => f.code);
    expect(codes('vehicle')).toContain('plate_no');
    expect(codes('vehicle')).not.toContain('from_date');
    expect(codes('booking')).toContain('from_date');
    expect(codes('booking')).not.toContain('plate_no');
    expect(codes('')).toEqual([]);
    expect(codes('team')).toEqual([]);
  });

  it('follows the server rules of Contractors: a contract names its contractor, a company does not carry team fields', () => {
    const codes = (rt: string) => forType(contractors, rt).fields.map((f) => f.code).sort();
    expect(codes('company')).toEqual(['company_status', 'company_type', 'contract_end', 'contract_ref', 'contract_start', 'contractor_name']);
    expect(codes('team')).toEqual(['contractor', 'specialization', 'team_name']);
    expect(codes('contract')).toEqual(['contract_end', 'contract_ref', 'contract_scopes', 'contract_start', 'contractor']);
    // a value typed under another type is not sent
    expect(typeData(contractors, 'team', { team_name: 'T1', contractor_name: 'Old company' })).toEqual({ team_name: 'T1' });
    // custom fields stay on every type
    expect(typeHides('contractors', 'team', { code: 'x_custom', label_en: 'X', type: 'text', is_custom: true })).toBe(false);
  });
});

describe('the record drawer: the type selector of the registers that are not site-scoped', () => {
  it('Car Dispatcher (EN): asks for the type, shows only its fields and sends the record type with the vehicle fields only', { timeout: 30_000 }, async () => {
    await signIn('pm');
    let sent: Record<string, unknown> | null = null;
    server.use(http.post(`${API_BASE}/registers/car_dispatcher/records`, async ({ request }) => { sent = (await request.clone().json()) as Record<string, unknown>; }));
    renderApp(<Routed />, at('car_dispatcher'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    const select = await screen.findByTestId('reg-record-type');
    expect(screen.queryByTestId('reg-site-search')).toBeNull();                         // not site-scoped: no site picker, the selector is there anyway
    expect(within(select).getAllByRole('option').slice(1).map((o) => o.textContent)).toEqual(['Vehicle', 'Booking']);
    expect(screen.queryByTestId('reg-field-plate_no')).toBeNull();                     // no fields before a type is chosen
    await u.click(screen.getByTestId('reg-save'));
    expect(await screen.findByTestId('reg-error-record_type')).toHaveTextContent('Choose the type of the record first');
    expect(sent).toBeNull();
    await u.selectOptions(select, 'booking');
    expect(screen.getByTestId('reg-field-from_date')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-field-plate_no')).toBeNull();
    await u.type(screen.getByTestId('reg-field-waiting_reason'), 'no car yet');
    await u.selectOptions(select, 'vehicle');
    expect(screen.queryByTestId('reg-field-from_date')).toBeNull();
    await u.type(screen.getByTestId('reg-field-plate_no'), 'TST-1');
    await u.click(screen.getByTestId('reg-save'));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent!.record_type).toBe('vehicle');
    expect(sent!.data).toEqual({ plate_no: 'TST-1' });                                 // the booking value typed before is not sent
  });

  it('Contractors (EN): a team shows the team fields, not the company ones', { timeout: 30_000 }, async () => {
    await signIn('pm');
    renderApp(<Routed />, at('contractors'));
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    const select = await screen.findByTestId('reg-record-type');
    expect(within(select).getByRole('option', { name: 'Contract' })).toBeInTheDocument();
    await u.selectOptions(select, 'team');
    expect(screen.getByTestId('reg-field-team_name')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-field-contractor_name')).toBeNull();
    await u.selectOptions(select, 'company');
    expect(screen.getByTestId('reg-field-contractor_name')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-field-team_name')).toBeNull();
  });

  it('Car Dispatcher (AR): the types and the message are in Arabic', { timeout: 30_000 }, async () => {
    await signIn('pm');
    renderApp(<Routed />, { ...at('car_dispatcher'), locale: 'ar' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('register-new'));
    const select = await screen.findByTestId('reg-record-type');
    expect(within(select).getByRole('option', { name: 'سيارة' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'حجز' })).toBeInTheDocument();
    await u.click(screen.getByTestId('reg-save'));
    expect(await screen.findByTestId('reg-error-record_type')).toHaveTextContent('اختر نوع السجل أولاً');
  });
});
