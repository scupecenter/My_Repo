import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { ListCatalogue, RegisterDefinition, RegisterRecord } from '@/api/types';
import { pathToField, validateRecord } from '@/lib/registerForms';
import { meetings, recId } from '@/mocks/registersData';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';
import { SettingsRoutes } from './settings/Settings';

/** Contract 0.12.5 (work package P5, migration 0057): the list catalogue (Q104), the new field types and Meetings (Q12, Q111). */
const settings = (opts = {}) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/lists', ...opts });
const register = (q = '') => renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: `/registers/meetings${q}` });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('Settings, lists (Q104)', () => {
  it('lists the catalogue with its status: the agreed lists confirmed, the others pending, critical marked; a value keeps its code', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings();
    expect(await screen.findByTestId('lists-row-TeamSpecialization')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-lists')).toHaveTextContent('Lists');
    expect(screen.getByTestId('lists-status-TeamSpecialization')).toHaveTextContent('Confirmed');
    expect(screen.getByTestId('lists-critical-TeamSpecialization')).toBeInTheDocument();
    expect(screen.getByTestId('lists-status-RiskStatus')).toHaveTextContent('Pending review');
    await u.click(screen.getByTestId('lists-row-TeamSpecialization'));
    const values = await screen.findByTestId('lists-values');
    expect(within(values).getByTestId('lists-value-Tower RT')).toBeInTheDocument();
    expect(within(values).getByTestId('lists-value-CW')).toHaveTextContent('Inactive');   // CW is a group now, kept for the old values
  });

  it('adds a value with a reason and refuses an alias another value already uses', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings();
    await u.click(await screen.findByTestId('lists-row-RiskStatus'));
    await u.click(await screen.findByTestId('lists-add-value'));
    await u.type(screen.getByTestId('lists-in-code'), 'Escalated');
    await u.type(screen.getByTestId('lists-in-aliases'), 'Esc, Raised');
    await u.type(screen.getByTestId('lists-dialog-reason'), 'Owner draft');
    await u.click(screen.getByTestId('lists-dialog-submit'));
    expect(await screen.findByTestId('lists-value-Escalated')).toHaveTextContent('Esc, Raised');
    await u.click(screen.getByTestId('lists-add-value'));
    await u.type(screen.getByTestId('lists-in-code'), 'Other');
    await u.type(screen.getByTestId('lists-in-aliases'), 'esc');
    await u.type(screen.getByTestId('lists-dialog-reason'), 'Owner draft');
    await u.click(screen.getByTestId('lists-dialog-submit'));
    expect(await screen.findByTestId('lists-err-aliases')).toHaveTextContent('Another value already uses this code, label or alias.');
  });

  it('refuses a critical list that accepts another value, and the code of a value never changes (mock = the database rules)', async () => {
    await signIn('pm');
    expect(await errCode(api.post('/list-catalogues', { body: { code: 'ProbeList', name_en: 'Probe', critical: true, allow_other: true, reason: 'test' } }))).toBe('422:validation_failed');
    const lists = (await api.get<{ items: ListCatalogue[] }>('/list-catalogues')).items;
    const sev = lists.find((c) => c.code === 'Severity')!;
    expect(await errCode(api.patch(`/list-catalogues/Severity/values/${sev.values[0]!.id}`, { version: 1, body: { code: 'X', reason: 'rename' } as never }))).toBe('422:validation_failed');
    await signIn('engineer');
    expect(await errCode(api.post('/list-catalogues', { body: { code: 'ProbeTwo', name_en: 'Probe', reason: 'test' } }))).toBe('403:action_forbidden');
  });

  it('is in Arabic when the locale is Arabic', async () => {
    await signIn('pm');
    settings({ locale: 'ar' });
    expect(await screen.findByTestId('lists-status-TeamSpecialization')).toHaveTextContent('معتمدة');
    expect(screen.getByTestId('settings-tab-lists')).toHaveTextContent('القوائم');
    expect(screen.getByTestId('lists-new')).toHaveTextContent('قائمة جديدة');
  });
});

describe('Meetings: structured fields and the conversion of the old text (Q12, Q111)', () => {
  it('offers the new field types on a new meeting: people, sites (none = project-wide), a minutes file from the documents, action rows', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    register('?record=new');
    expect(await screen.findByTestId('reg-field-attendee_users')).toBeInTheDocument();
    expect(screen.getByTestId('reg-field-linked_site_ids-project')).toHaveTextContent('No site: a project-wide record');
    expect(screen.getByTestId('reg-field-minutes_file-none')).toHaveTextContent('Upload the file in the Documents tab');
    expect(screen.getByTestId('reg-list-pending-meeting_type')).toHaveTextContent('Draft list');
    await u.click(screen.getByTestId('reg-field-action_items_list-add'));
    expect(screen.getByTestId('reg-field-action_items_list-0-description')).toBeInTheDocument();
    expect(screen.getByTestId('reg-field-action_items_list-0-status')).toHaveTextContent('Open');
    // the old free text is not offered on a new record
    expect(screen.queryByTestId('reg-field-attendees')).toBeNull();
    // a person is picked by name and shown as a chip
    await u.type(screen.getByTestId('reg-field-attendee_users'), 'Mona');
    await u.click(await screen.findByTestId('reg-field-attendee_users-opt-1102'));
    expect(screen.getByTestId('reg-field-attendee_users-chips')).toHaveTextContent('Mona Fathi');
  });

  it('converts the old text after review, once; owners and the due date are given for the converted actions', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    register(`?record=${recId(15)}`);
    const box = await screen.findByTestId('reg-legacy');
    expect(box).toHaveTextContent('entered with free text');
    expect(screen.getByTestId('reg-field-attendees')).toBeDisabled();   // the old text is read-only
    await u.click(within(box).getByTestId('reg-legacy-open'));
    const prop = await screen.findByTestId('reg-legacy-proposal');
    expect(within(prop).getByText('Send the LLD')).toBeInTheDocument();
    expect(screen.getByTestId('reg-legacy-minutes')).toHaveTextContent('A reference is not an upload');
    expect(screen.getByTestId('reg-legacy-dialog-submit')).toBeDisabled();   // owner and due date first
    await u.type(screen.getByTestId('reg-legacy-owner'), 'Ahmed');
    await u.click(await screen.findByTestId('reg-legacy-owner-opt-1001'));
    await u.type(screen.getByTestId('reg-legacy-due'), '2026-11-20');
    await u.click(screen.getByTestId('reg-legacy-x-1'));   // drop "Book the crane"
    await u.type(screen.getByTestId('reg-legacy-dialog-reason'), 'Reviewed the old text');
    await u.click(screen.getByTestId('reg-legacy-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('reg-legacy')).toHaveTextContent('Converted on 2026-11-04'));
    const r = await api.get<RegisterRecord>(`/registers/meetings/records/${recId(15)}`);
    expect((r.data.action_items_list as { description: string; owner: string }[]).map((x) => x.description)).toEqual(['Send the LLD']);
    expect(await errCode(api.post(`/registers/meetings/records/${recId(15)}/legacy-conversion`, { version: r.version, body: { values: {}, reason: 'again' } }))).toBe('409:duplicate');
  });
});

describe('the form rules of the new types', () => {
  it('lets an open list keep another value, wants every required column of a row, and maps a nested error to its field', () => {
    const def: RegisterDefinition = { ...meetings, fields: meetings.fields.map((f) => (f.code === 'meeting_type' ? { ...f, options: [{ value: 'Weekly', label_en: 'Weekly' }] } : f)) };
    const ok = validateRecord(def, { meeting_date: '2026-01-01', title: 'x', meeting_type: 'Kick-off' }, null, '2026-11-04');
    expect(ok.meeting_type).toBeUndefined();
    const rows = validateRecord(def, { meeting_date: '2026-01-01', title: 'x', action_items_list: [{ description: 'a' }] }, null, '2026-11-04');
    expect(rows.action_items_list).toMatchObject({ code: 'row_incomplete' });
    expect(validateRecord(def, { title: 'x', attendee_users: [] }, null, '2026-11-04').meeting_date).toMatchObject({ code: 'required' });
    expect(pathToField('/data/action_items_list/0/owner')).toBe('action_items_list');
    expect(pathToField('/data/attendee_users/1')).toBe('attendee_users');
  });
});
