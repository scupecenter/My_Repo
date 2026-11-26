import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { RegisterColumnsScreen } from '@/api/types';
import { resetRegisterColumns } from '@/mocks/handlers.registerColumns';
import { renderApp, signIn } from '@/test/utils';
import { RegisterColumns } from './settings/RegisterColumns';

/**
 * Contract 0.15.13: the admin screen of the columns of a register (Settings > Register columns), as the mock of admin_reg_field_save / admin_reg_field_delete
 * decides it: required reason, step-up for the delete, protected columns, hard delete against deactivation.
 */
const stepUpDone = () => api.post('/__mock/step-up');
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const page = () => renderApp(<Routes><Route path="/admin/settings/registers/columns" element={<RegisterColumns />} /></Routes>, { route: '/admin/settings/registers/columns?register=gecol' });
const screenOf = () => api.get<RegisterColumnsScreen>('/registers/gecol/fields');

beforeEach(() => resetRegisterColumns());

describe('register columns (0.15.13): the rules of the doors', () => {
  it('lets only the System Admin read and write', async () => {
    await signIn('engineer');
    expect(await errCode(screenOf())).toBe('403:action_forbidden');
  });

  it('adds a column with a reason, rejects a taken code, and keeps a list column tied to a catalogue', async () => {
    await signIn('pm');
    expect(await errCode(api.post('/registers/gecol/fields', { body: { code: 'meter_ref', label_en: 'Meter no.', field_type: 'text' } }))).toBe('422:validation_failed');
    await api.post('/registers/gecol/fields', { body: { code: 'meter_ref', label_en: 'Meter no.', field_type: 'text', reason: 'Track the meter' } });
    expect((await screenOf()).fields.some((f) => f.code === 'meter_ref')).toBe(true);
    expect(await errCode(api.post('/registers/gecol/fields', { body: { code: 'meter_ref', label_en: 'Again', field_type: 'text', reason: 'Track the meter' } }))).toBe('409:duplicate');
    expect(await errCode(api.post('/registers/gecol/fields', { body: { code: 'phase', label_en: 'Phase', field_type: 'list', reason: 'Track the phase' } }))).toBe('422:validation_failed');
  });

  it('refuses to delete or retype a protected column, and needs the step-up for a delete', async () => {
    await signIn('pm');
    const scr = await screenOf();
    expect(scr.fields.find((f) => f.code === 'pr_no')?.is_system).toBe(true);
    expect(await errCode(api.del('/registers/gecol/fields/pr_no', { body: { reason: 'Clean up the register' } }))).toBe('409:system_field');
    await api.post('/registers/gecol/fields', { body: { code: 'meter_ref', label_en: 'Meter no.', field_type: 'text', reason: 'Track the meter' } });
    expect(await errCode(api.del('/registers/gecol/fields/meter_ref', { body: { reason: 'Not needed any more' } }))).toBe('401:step_up_required');
    await stepUpDone();
    await api.del('/registers/gecol/fields/meter_ref', { body: { reason: 'Not needed any more' } });
    expect((await screenOf()).fields.some((f) => f.code === 'meter_ref')).toBe(false);
  });

  it('deactivates instead of deleting when a record held a value, and reactivates', async () => {
    await signIn('pm'); await stepUpDone();
    const used = (await screenOf()).fields.find((f) => f.code === 'request_date');
    expect(used?.usage?.records_with_value).toBeGreaterThan(0);
    expect(await api.del<{ mode: string }>('/registers/gecol/fields/request_date', { body: { reason: 'Retire the old date' } })).toMatchObject({ mode: 'deactivated' });
    expect((await screenOf()).fields.find((f) => f.code === 'request_date')?.is_active).toBe(false);
    await api.patch('/registers/gecol/fields/request_date', { body: { is_active: true, reason: 'Needed again' } });
    expect((await screenOf()).fields.find((f) => f.code === 'request_date')?.is_active).toBe(true);
  });

  it('keeps sections empty-only for delete and renames the register', async () => {
    await signIn('pm');
    const made = await api.post<{ id: string }>('/registers/gecol/sections', { body: { name_en: 'Site data', reason: 'Group the columns' } });
    await api.patch('/registers/gecol/fields/pr_no', { body: { section: 'Site data', reason: 'Group the columns' } });
    expect(await errCode(api.del(`/registers/gecol/sections/${made.id}`, { body: { reason: 'Not needed any more' } }))).toBe('409:section_not_empty');
    await api.patch('/registers/gecol/fields/pr_no', { body: { section: null, reason: 'Group the columns' } });
    await api.del(`/registers/gecol/sections/${made.id}`, { body: { reason: 'Not needed any more' } });
    await api.patch('/registers/gecol', { body: { name_en: 'GECOL supply', reason: 'Clearer name' } });
    expect((await screenOf()).register.name_en).toBe('GECOL supply');
  });
});

describe('Settings > Register columns', () => {
  it('lists the columns, marks the protected ones, and shows what a delete does before it is confirmed', async () => {
    await signIn('pm'); await stepUpDone();
    const u = userEvent.setup();
    page();
    const table = await screen.findByTestId('regcols-table');
    expect(await within(table).findByTestId('regcols-protected-pr_no')).toBeInTheDocument();
    expect(screen.getByTestId('regcols-delete-pr_no')).toBeDisabled();
    await u.click(screen.getByTestId('regcols-delete-request_date'));
    expect(await screen.findByTestId('column-delete-mode')).toHaveTextContent(/deactivat/i);
    await u.type(screen.getByTestId('column-delete-reason'), 'Retire the old date');
    await u.click(screen.getByTestId('column-delete-submit'));
    await waitFor(() => expect(screen.getByTestId('regcols-reactivate-request_date')).toBeInTheDocument());
  });
});

describe('register columns page: drag and drop, add before and after', () => {
  it('drops a column on another to reorder, and opens the add dialog placed before a column', async () => {
    await signIn('pm');
    page();
    const rows = async () => (await screen.findAllByTestId(/^regcols-row-/)).map((r) => r.getAttribute('data-testid')!.replace('regcols-row-', ''));
    const before = await rows();
    expect(before.length).toBeGreaterThan(2);
    const [first, second] = before as [string, string];
    const dt = { setData: () => undefined, getData: () => '' };
    const { fireEvent } = await import('@testing-library/react');
    expect(screen.getByTestId(`regcols-row-${first}`)).not.toHaveAttribute('draggable');
    fireEvent.dragStart(screen.getByTestId(`regcols-grip-${first}`), { dataTransfer: dt });
    fireEvent.dragOver(screen.getByTestId(`regcols-row-${second}`), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId(`regcols-row-${second}`), { dataTransfer: dt });
    await waitFor(async () => expect((await rows()).slice(0, 2)).toEqual([second, first]));
    const u = userEvent.setup();
    await u.click(screen.getByTestId(`regcols-before-${second}`));
    expect(await screen.findByTestId('column-dialog')).toBeInTheDocument();
    expect(within(screen.getByTestId('column-dialog')).getByTestId('col-code')).toBeInTheDocument();
    expect(within(screen.getByTestId('column-dialog')).getByTestId('column-add-impact')).toHaveTextContent(/new version of the register template/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();   // in the page, not a modal
  });
});

describe('register columns page: the Hide button', () => {
  it('hides a column from every place it is listed with one click and shows it again; the column stays active', async () => {
    await signIn('pm');
    page();
    const rows = await screen.findAllByTestId(/^regcols-row-/);
    const code = rows[0]!.getAttribute('data-testid')!.replace('regcols-row-', '');
    const u = userEvent.setup();
    await u.click(screen.getByTestId(`regcols-hide-${code}`));
    expect(await screen.findByTestId(`regcols-hidden-${code}`)).toBeInTheDocument();
    expect(screen.getByTestId(`regcols-delete-${code}`)).toBeInTheDocument();          // still active: nothing was deleted or deactivated
    await u.click(screen.getByTestId(`regcols-hide-${code}`));
    await waitFor(() => expect(screen.queryByTestId(`regcols-hidden-${code}`)).not.toBeInTheDocument());
  });
});

describe('register columns: edit in place next to the pencil', () => {
  it('asks for the reason, then saves a new name in the row and keeps the pencil', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    page();
    const row = (await screen.findAllByTestId(/^regcols-row-/))[0]!;
    const code = row.getAttribute('data-testid')!.replace('regcols-row-', '');
    expect(screen.getByTestId(`regcols-edit-${code}`)).toBeInTheDocument();
    await u.click(screen.getByTestId(`regcols-cell-name-${code}`));
    const input = screen.getByTestId(`regcols-cell-name-${code}-input`);
    await u.clear(input);
    await u.type(input, 'Renamed inline{Enter}');
    expect(await screen.findByTestId(`regcols-cell-name-${code}-err`)).toBeInTheDocument();
    await u.type(screen.getByTestId('regcols-inline-reason'), 'Owner asked');
    await u.click(screen.getByTestId(`regcols-cell-name-${code}-input`));
    await u.keyboard('{Enter}');
    expect(await screen.findByText('Renamed inline')).toBeInTheDocument();
  });
});
