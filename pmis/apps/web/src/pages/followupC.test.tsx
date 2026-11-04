import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { ListCatalogue, RegisterDefinition, RegisterRecord, SiteDetail } from '@/api/types';
import { db, save } from '@/mocks/db';
import { resetQcMocks } from '@/mocks/handlers.qc';
import { recId } from '@/mocks/registersData';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';
import { SettingsRoutes } from './settings/Settings';
import { Site } from './Site';

/**
 * Contract 0.13.2 (follow-up group C of the technical decisions of 2026-11-04, migration 0068): Q260 the Severity list mirrors the snag severities, Q265 step-up
 * for accepting pending evidence, Q267 a System Admin cancels an approved Quality snag record, Q291 external attendees, Q349 the site page follows the pipeline
 * style of the dashboard.
 */
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const Routed = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
const QS = recId(17);   // the approved Quality snag record of the mock
const freshStepUp = () => { db().session!.stepupAt = Date.now(); save(); };

beforeEach(() => resetQcMocks());

describe('Q349: the site page follows the pipeline style of the dashboard', () => {
  it('shows the rings (A) by default and the flat track (B) once the System Admin chose B; the engineer cannot choose', async () => {
    await signIn('pm');
    const id = siteIdOf(0);
    expect((await api.get<SiteDetail>(`/sites/${id}`)).pipeline_variant).toBe('A');
    renderApp(<SiteAt />, { route: `/sites/${id}?stream=CW` });
    await waitFor(() => expect(screen.getByTestId('pipeline')).toHaveAttribute('data-variant', 'A'));
    cleanup();
    await api.put('/dashboard/pipeline-variant', { body: { variant: 'B', reason: 'the owner picked the flat track' } });
    expect((await api.get<SiteDetail>(`/sites/${id}`)).pipeline_variant).toBe('B');
    renderApp(<SiteAt />, { route: `/sites/${id}?stream=CW` });
    await waitFor(() => expect(screen.getByTestId('pipeline')).toHaveAttribute('data-variant', 'B'));
    expect(screen.getByTestId('pipe-track-b')).toBeInTheDocument();
    // the stages are the same either way
    expect(await screen.findAllByTestId(/^pipe-node-/)).toHaveLength(3);
    cleanup();
    await signIn('engineer');
    expect(await errCode(api.put('/dashboard/pipeline-variant', { body: { variant: 'A', reason: 'I prefer rings' } }))).toBe('403:action_forbidden');
    expect((await api.get<SiteDetail>(`/sites/${id}`)).pipeline_variant).toBe('B');
  });
});

describe('Q267: a System Admin cancels an approved Quality snag record', () => {
  it('offers the control only to the System Admin, asks for a reason and step-up, and voids the record', async () => {
    await signIn('reviewer');
    const seen = await api.get<RegisterRecord>(`/registers/quality/records/${QS}`);
    expect(seen.state).toBe('approved');
    expect(seen.allowed_actions).not.toContain('cancel_snag');

    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routed />, { route: `/registers/quality?record=${QS}` });
    await u.click(await screen.findByTestId('reg-cancel-snag'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Cancel this approved snag record (entered by mistake)');
    // a reason is mandatory
    await u.click(screen.getByTestId('reject-submit'));
    expect(await screen.findByTestId('reject-error')).toBeInTheDocument();
    freshStepUp();
    await u.type(screen.getByTestId('reject-note'), 'Entered twice by mistake');
    await u.click(screen.getByTestId('reject-submit'));
    await waitFor(() => expect(screen.getByTestId('reg-state')).toHaveTextContent('Voided'));
    expect(screen.queryByTestId('reg-cancel-snag')).toBeNull();
    const rec = await api.get<RegisterRecord>(`/registers/quality/records/${QS}`);
    expect(rec.state).toBe('voided');
    expect(rec.allowed_actions).not.toContain('cancel_snag');
  });

  it('mock = contract: step-up (401), a reason (422), only the System Admin (403), only an approved snag record (409)', async () => {
    await signIn('pm');
    const rec = await api.get<RegisterRecord>(`/registers/quality/records/${QS}`);
    expect(rec.allowed_actions).toContain('cancel_snag');
    // no fresh step-up
    expect(await errCode(api.post(`/registers/quality/records/${QS}/cancel-snag`, { version: rec.version, body: { reason: 'entered by mistake' } }))).toBe('401:step_up_required');
    freshStepUp();
    expect(await errCode(api.post(`/registers/quality/records/${QS}/cancel-snag`, { version: rec.version, body: { reason: 'x' } }))).toBe('422:validation_failed');
    expect(await errCode(api.post(`/registers/quality/records/${QS}/cancel-snag`, { version: rec.version + 3, body: { reason: 'entered by mistake' } }))).toBe('412:precondition_failed');
    // a record of another register is not a Quality snag record
    expect(await errCode(api.post(`/registers/quality/records/${recId(1)}/cancel-snag`, { version: 1, body: { reason: 'entered by mistake' } }))).toBe('404:not_found');
    const done = await api.post<RegisterRecord>(`/registers/quality/records/${QS}/cancel-snag`, { version: rec.version, body: { reason: 'entered by mistake' } });
    expect(done.state).toBe('voided');
    expect(await errCode(api.post(`/registers/quality/records/${QS}/cancel-snag`, { version: done.version, body: { reason: 'entered by mistake' } }))).toBe('409:invalid_transition');
    cleanup();
    await signIn('engineer');
    expect(await errCode(api.post(`/registers/quality/records/${QS}/cancel-snag`, { version: done.version, body: { reason: 'entered by mistake' } }))).toBe('403:action_forbidden');
  });

  it('is in Arabic when the locale is Arabic', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: `/registers/quality?record=${QS}`, locale: 'ar' });
    expect(await screen.findByTestId('reg-cancel-snag')).toHaveTextContent('إلغاء سجل الملاحظة');
  });
});

describe('Q265: accepting pending evidence needs step-up', () => {
  it('the mock asks for a fresh step-up to accept, not to reject', async () => {
    await signIn('engineer');
    const id = siteIdOf(3);
    const s = await api.post<{ id: string }>(`/sites/${id}/snags`, { body: { snag_type_id: (await api.get<{ items: { id: string }[] }>('/snag-types')).items[0]!.id, scope: 'CW', title: 'Earth bar loose', severity: 'MAJOR' } });
    const f = (name: string, body: string) => new File([body], name, { type: 'image/jpeg' });
    const photo = async (name: string): Promise<string> => {
      const fd = new FormData();
      fd.append('file', f(name, 'exif:future'));
      return (await api.post<{ id: string }>(`/snags/${s.id}/photos`, { body: fd })).id;
    };
    const p1 = await photo('a.jpg');
    const p2 = await photo('b.jpg');
    cleanup();
    await signIn('pm');
    expect(await errCode(api.post(`/snags/${s.id}/photos/${p1}/evidence`, { body: { decision: 'accept', note: 'camera clock was wrong' } }))).toBe('401:step_up_required');
    // rejecting needs none
    const rej = await api.post<{ photos: { id: string; status: string }[] }>(`/snags/${s.id}/photos/${p2}/evidence`, { body: { decision: 'reject', note: 'not the fix' } });
    expect(rej.photos.find((x) => x.id === p2)?.status).toBe('rejected');
    freshStepUp();
    const acc = await api.post<{ photos: { id: string; status: string }[] }>(`/snags/${s.id}/photos/${p1}/evidence`, { body: { decision: 'accept', note: 'camera clock was wrong' } });
    expect(acc.photos.find((x) => x.id === p1)?.status).toBe('accepted');
  });
});

describe('Q260: the Severity list is the snag severities; Q291: external attendees', () => {
  it('the list reads CRITICAL, MAJOR and MINOR with their names and cannot be edited directly', async () => {
    await signIn('pm');
    const lists = (await api.get<{ items: ListCatalogue[] }>('/list-catalogues')).items;
    const sev = lists.find((c) => c.code === 'Severity')!;
    expect(sev.values.map((v) => v.code)).toEqual(['CRITICAL', 'MAJOR', 'MINOR']);
    expect(sev.values.map((v) => v.label_en)).toEqual(['Critical', 'Major', 'Minor']);
    expect(sev.values[0]!.label_ar).toBe('حرجة');
    expect(await errCode(api.post('/list-catalogues/Severity/values', { body: { code: 'TRIVIAL', label_en: 'Trivial', reason: 'owner asked' } }))).toBe('422:validation_failed');
    expect(await errCode(api.patch(`/list-catalogues/Severity/values/${sev.values[0]!.id}`, { version: 1, body: { label_en: 'Worse', reason: 'owner asked' } }))).toBe('422:validation_failed');
  });

  it('Settings, lists: the Severity list says it follows the snag severities and offers no add or edit; another list does', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/lists' });
    await u.click(await screen.findByTestId('lists-row-Severity'));
    expect(await screen.findByTestId('lists-mirrored')).toHaveTextContent('follows the snag severities');
    expect(screen.queryByTestId('lists-add-value')).toBeNull();
    expect(screen.queryByTestId('lists-value-edit-CRITICAL')).toBeNull();
    expect(screen.getByTestId('lists-value-CRITICAL')).toHaveTextContent('Critical');
    await u.click(screen.getByTestId('lists-row-RiskStatus'));
    expect(await screen.findByTestId('lists-add-value')).toBeInTheDocument();
    expect(screen.queryByTestId('lists-mirrored')).toBeNull();
  });

  it('the Meetings form has the optional text field external attendees beside the attendees, and saves it', async () => {
    await signIn('pm');
    const defs = (await api.get<{ items: RegisterDefinition[] }>('/registers')).items;
    const m = defs.find((d) => d.register_key === 'meetings')!;
    expect(m.fields.find((f) => f.code === 'external_attendees')).toMatchObject({ type: 'text', required: false });
    const u = userEvent.setup();
    renderApp(<Routed />, { route: '/registers/meetings?record=new' });
    const field = await screen.findByTestId('reg-field-external_attendees');
    expect(screen.getByTestId('reg-field-attendee_users')).toBeInTheDocument();
    expect(within(field.closest('div')!.parentElement!).getByText('External attendees')).toBeInTheDocument();
    await u.type(screen.getByTestId('reg-field-title'), 'Weekly with the vendor');
    await u.type(screen.getByTestId('reg-field-meeting_date'), '2026-11-03');
    await u.type(field, 'A&T Global; GECOL power team');
    const prompt = vi.spyOn(window, 'prompt');
    await u.click(screen.getByTestId('reg-save'));
    await waitFor(async () => {
      const list = await api.get<{ items: RegisterRecord[] }>('/registers/meetings/records', { query: { limit: 50 } });
      expect(list.items.some((r) => r.data.external_attendees === 'A&T Global; GECOL power team')).toBe(true);
    });
    prompt.mockRestore();
  });
});
