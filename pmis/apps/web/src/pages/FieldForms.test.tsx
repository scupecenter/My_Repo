import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import type { FieldForms } from '@/api/types';
import { FieldFormsPanel, formProblems } from '@/components/FieldFormsPanel';
import { SignaturePad } from '@/components/SignaturePad';
import { enqueue, memoryStore } from '@/lib/fieldOutbox';
import { apiSender, syncOutbox } from '@/lib/fieldSync';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Offline field forms with a signature pad (migration 0667, contract 0.15.596). */

const SITE = '11111111-1111-4111-8111-111111111111';
const KIND = { code: 'handover', name_en: 'Handover', name_ar: 'تسليم', enabled: true, signature: true, fields: [
  { key: 'note', label_en: 'Note', label_ar: 'ملاحظة', type: 'text' as const, required: true, options: [] },
  { key: 'state', label_en: 'State', label_ar: 'الحالة', type: 'choice' as const, required: false, options: ['good', 'bad'] },
] };
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

async function seedKind() {
  await api.post('/__mock/step-up');
  const cur = await api.get<FieldForms>('/settings/field-forms');
  await api.put('/settings/field-forms', { version: cur.version, body: { forms: [KIND], reason: 'test' } });
}

beforeEach(() => { HTMLCanvasElement.prototype.toDataURL = () => PNG; });
afterEach(() => { vi.restoreAllMocks(); });

describe('Settings > Screens > Field forms', () => {
  it('lists the section, and saves a form with a field, a choice and a signature with a reason and a step-up', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const u = userEvent.setup();
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/screens/field-forms' });
    await screen.findByTestId('page-fieldforms-settings');
    expect(screen.getByTestId('ffset-save')).toBeDisabled();
    await u.click(screen.getByTestId('ffset-form-add'));
    await u.type(screen.getByTestId('ffset-form-0-code'), 'handover');
    await u.type(screen.getByTestId('ffset-form-0-en'), 'Handover');
    await u.click(screen.getByTestId('ffset-form-0-signature'));
    await u.click(screen.getByTestId('ffset-form-0-field-add'));
    await u.type(screen.getByTestId('ffset-field-0-0-key'), 'note');
    await u.type(screen.getByTestId('ffset-field-0-0-en'), 'Note');
    await u.click(screen.getByTestId('ffset-field-0-0-required'));
    await u.click(screen.getByTestId('ffset-save'));
    await u.type(await screen.findByTestId('ffset-dialog-reason'), 'Field forms pilot');
    await u.click(screen.getByTestId('ffset-dialog-submit'));
    await waitFor(async () => expect((await api.get<FieldForms>('/settings/field-forms')).version).toBe(2));
    const s = await api.get<FieldForms>('/settings/field-forms');
    expect(s.forms).toMatchObject([{ code: 'handover', enabled: true, signature: true, fields: [{ key: 'note', type: 'text', required: true }] }]);
    expect(s.updated_by).toMatchObject({ employee_id: '1001' });
  });

  it('the server refuses a choice field with one option, and a duplicate field key (422)', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const cur = await api.get<FieldForms>('/settings/field-forms');
    const bad = (forms: object[]) => api.put('/settings/field-forms', { version: cur.version, body: { forms, reason: 'test' } }).then(() => 'ok', (e: { status?: number }) => e.status);
    expect(await bad([{ ...KIND, fields: [{ ...KIND.fields[1]!, options: ['only'] }] }])).toBe(422);
    expect(await bad([{ ...KIND, fields: [KIND.fields[0], KIND.fields[0]] }])).toBe(422);
    expect(await bad([KIND, KIND])).toBe(422);
  });
});

describe('the form rules of the Field screen', () => {
  it('needs the required fields, a known choice and, for a signed kind, the drawing and the name', () => {
    const k = KIND as unknown as Parameters<typeof formProblems>[0];
    expect(formProblems(k, {}, null, '')).toEqual(['note', 'signature']);
    expect(formProblems(k, { note: 'ok', state: 'good' }, PNG, 'Ali')).toEqual([]);
    expect(formProblems(k, { note: 'ok', state: 'weird' }, PNG, 'Ali')).toEqual(['state']);
    expect(formProblems(k, { note: 'ok' }, PNG, '   ')).toEqual(['signature']);
  });
});

describe('the signature pad', () => {
  it('counts strokes, undoes and clears, and gives the PNG while something is drawn', () => {
    const changes: (string | null)[] = [];
    render(<SignaturePad onChange={(p) => changes.push(p)} />);
    const c = screen.getByTestId('sigpad-canvas');
    expect(screen.getByTestId('sigpad-undo')).toBeDisabled();
    fireEvent.pointerDown(c, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(c, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(c, { pointerId: 1 });
    fireEvent.pointerDown(c, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(c, { pointerId: 1 });
    expect(c).toHaveAttribute('data-strokes', '2');
    expect(changes.at(-1)).toBe(PNG);
    fireEvent.click(screen.getByTestId('sigpad-undo'));
    expect(c).toHaveAttribute('data-strokes', '1');
    fireEvent.click(screen.getByTestId('sigpad-clear'));
    expect(c).toHaveAttribute('data-strokes', '0');
    expect(changes.at(-1)).toBeNull();
  });
});

describe('Field forms panel and the queue', () => {
  it('shows only enabled kinds, refuses an empty signed form, and queues the filled one with the signature', async () => {
    await signIn('pm');
    await seedKind();
    const u = userEvent.setup();
    const queued: unknown[] = [];
    renderApp(<FieldFormsPanel siteId={SITE} online={false} onQueue={async (d) => { queued.push(d); return true; }} />);
    await u.selectOptions(await screen.findByTestId('field-form-kind'), 'handover');
    await u.click(screen.getByTestId('field-form-queue'));
    expect(queued).toHaveLength(0);
    expect(await screen.findByTestId('field-form-sig-err')).toBeInTheDocument();
    await u.type(screen.getByTestId('ff-note'), 'All clear');
    await u.type(screen.getByTestId('ff-signer'), 'Ali Hassan');
    const c = screen.getByTestId('sigpad-canvas');
    fireEvent.pointerDown(c, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(c, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(c, { pointerId: 1 });
    await u.click(screen.getByTestId('field-form-queue'));
    await waitFor(() => expect(queued).toHaveLength(1));
    expect(queued[0]).toMatchObject({ formCode: 'handover', answers: { note: 'All clear' }, signature: PNG, signerName: 'Ali Hassan' });
  });

  it('a queued form is sent with its action id, once: a replay returns the first row', async () => {
    await signIn('pm');
    await seedKind();
    const store = memoryStore();
    const r = await enqueue(store, { kind: 'form_submit', snagId: 'form:1', snagLabel: 'Handover', siteId: SITE, formCode: 'handover', answers: { note: 'ok' }, signature: PNG, signerName: 'Ali', capturedAt: new Date().toISOString() }, { max_queue: 5, max_photo_mb: 1 });
    expect(r.ok).toBe(true);
    expect(await syncOutbox(store, apiSender)).toEqual({ sent: 1, attention: 0, stopped: null });
    const kept = (await store.list())[0]!;
    expect(kept.state).toBe('done');
    expect(kept.signature).toBeUndefined();
    const list = await api.get<{ items: { signed: boolean; signer_name: string }[] }>(`/sites/${SITE}/field-forms`);
    expect(list.items).toMatchObject([{ signed: true, signer_name: 'Ali' }]);
    // the same action sent again (a lost answer): the server returns the first row and writes nothing
    const again = await api.post<{ replayed: boolean }>(`/sites/${SITE}/field-forms`, { body: { client_id: kept.id, form_code: 'handover', answers: { note: 'ok' }, signature: PNG, signer_name: 'Ali', captured_at: new Date().toISOString() } });
    expect(again.replayed).toBe(true);
    expect((await api.get<{ items: unknown[] }>(`/sites/${SITE}/field-forms`)).items).toHaveLength(1);
  });

  it('an answer the form does not allow is refused by the server and the action needs attention', async () => {
    await signIn('pm');
    await seedKind();
    const store = memoryStore();
    await enqueue(store, { kind: 'form_submit', snagId: 'form:2', snagLabel: 'Handover', siteId: SITE, formCode: 'handover', answers: { note: 'ok', state: 'weird' }, signature: PNG, signerName: 'Ali' }, { max_queue: 5, max_photo_mb: 1 });
    expect(await syncOutbox(store, apiSender)).toMatchObject({ sent: 0, attention: 1 });
    expect((await store.list())[0]).toMatchObject({ state: 'attention', reason: 'validation_failed' });
  });
});
