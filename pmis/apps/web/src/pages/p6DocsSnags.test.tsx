import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { DocumentsQcSettings, SnagSeverityList } from '@/api/qc';
import { SlotList } from '@/components/DocSlots';
import { snagError } from '@/components/SiteSnags';
import { db, save } from '@/mocks/db';
import { resetQcMocks } from '@/mocks/handlers.qc';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { Site } from './Site';

/**
 * Contract 0.12.4 (migration 0056, work package P6): the severity of a snag (Q233), the finder / fixer / approver and no self-approval of a snag (D230b),
 * pending evidence decided by L2 (Q232), the documents and QC settings and the severity catalogue (Q229, Q232, Q233).
 */
const SITE = siteIdOf(3);
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
const jpg = (name = 'fix.jpg', body = 'jpeg body') => new File([body], name, { type: 'image/jpeg' });

beforeEach(() => resetQcMocks());

async function raise(title: string): Promise<string> {
  const u = userEvent.setup();
  await u.click(await screen.findByTestId('snag-raise'));
  await u.type(await screen.findByTestId('snag-raise-title'), title);
  await u.selectOptions(screen.getByTestId('snag-raise-severity'), await screen.findByRole('option', { name: 'Minor' }));
  await u.click(screen.getByTestId('snag-raise-send'));
  const card = (await screen.findAllByTestId(/^snag-[0-9a-f-]{36}$/))[0]!;
  return card.dataset.testid!.replace('snag-', '');
}

describe('P6: QC snags', () => {
  it('the raiser who is also L2 cannot close the snag (D230b); a future-dated photo waits as pending evidence until another L2 accepts it', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${SITE}?tab=snags` });
    const sid = await raise('Loose bolt on bracket');
    expect(screen.getByTestId(`snag-severity-${sid}`)).toHaveTextContent('Minor');
    expect(screen.getByTestId(`snag-people-${sid}`)).toHaveTextContent(/Found by/);
    cleanup();

    // the site engineer uploads a photo dated in the future: kept as pending evidence, not counted
    await signIn('engineer');
    const u = userEvent.setup({ applyAccept: false });
    renderApp(<SiteAt />, { route: `/sites/${SITE}?tab=snags` });
    await u.upload(await screen.findByTestId(`snag-input-${sid}`), jpg('fix.jpg', 'exif:future'));
    expect(await screen.findAllByTestId(/^snag-photo-pending-/)).toHaveLength(1);
    expect(screen.queryByTestId(`snag-submit-${sid}`)).toBeNull();
    await u.upload(screen.getByTestId(`snag-input-${sid}`), jpg('fix2.jpg'));
    await u.click(await screen.findByTestId(`snag-submit-${sid}`));
    await waitFor(() => expect(screen.getByTestId(`snag-state-${sid}`)).toHaveTextContent('Waiting for L2'));
    cleanup();

    // the PM raised it: no approve button, and the reason is shown in advance
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${SITE}?tab=snags` });
    expect(await screen.findByTestId(`snag-self-blocked-${sid}`)).toHaveTextContent(/another approver must close it/);
    expect(screen.queryByTestId(`snag-approve-${sid}`)).toBeNull();
    expect(screen.queryByTestId(/^snag-evidence-accept-/)).toBeNull();
  });

  it('L2 accepts a pending-evidence photo with a note', async () => {
    await signIn('engineer');
    const u = userEvent.setup({ applyAccept: false });
    renderApp(<SiteAt />, { route: `/sites/${SITE}?tab=snags` });
    const sid = await raise('Earth bar loose');
    await u.upload(await screen.findByTestId(`snag-input-${sid}`), jpg('fix.jpg', 'exif:future'));
    expect(await screen.findAllByTestId(/^snag-photo-pending-/)).toHaveLength(1);
    cleanup();
    await signIn('pm');
    db().session!.stepupAt = Date.now(); save();   // contract 0.13.2 (Q265): accepting pending evidence needs a recent step-up, like the closure
    renderApp(<SiteAt />, { route: `/sites/${SITE}?tab=snags` });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('camera clock was wrong');
    const accept = (await screen.findAllByTestId(/^snag-evidence-accept-/))[0]!;
    await u.click(accept);
    await waitFor(() => expect(screen.queryAllByTestId(/^snag-photo-pending-/)).toHaveLength(0));
    expect(prompt).toHaveBeenCalled();
    prompt.mockRestore();
  });

  it('is in Arabic in the Arabic interface', async () => {
    await signIn('engineer');
    renderApp(<SiteAt />, { route: `/sites/${SITE}?tab=snags`, locale: 'ar' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('snag-raise'));
    expect(await screen.findByRole('option', { name: 'رئيسية' })).toBeInTheDocument();
    expect(screen.getByText('الخطورة')).toBeInTheDocument();
  });

  it('says plainly why an approval is refused', () => {
    const t = (k: string) => k;
    const err = new ApiError(403, { type: 'about:blank', title: 'x', status: 403, code: 'self_approval_forbidden' } as never);
    expect(snagError(t, err)).toBe('snags.err.self_approval_forbidden');
  });
});

describe('P6: documents', () => {
  it('a slot shows a pending determination, an inherited approval and the requirement it shares with the task', async () => {
    await signIn('engineer');
    const slot = {
      id: '93000000-0000-4000-8000-000000000001', doc_code: 'B1', name_en: 'PR e-mail', status: 'not_required', mandatory: true, conditional: true, files: [],
      formats: ['pdf'], max_size_mb: 20, determination_pending: true, inherited_approval: true,
      shared_with: { slot_id: '93000000-0000-4000-8000-000000000002', owner: 'task', task_code: 'B2', status: 'uploaded', has_file: true },
    };
    renderApp(<SlotList slots={[slot as never]} target={{ base: '/tasks/t1', refresh: [] }} edit={false} />);
    expect(screen.queryByTestId('slot-optional')).toBeNull();
    expect(screen.getByTestId(`slot-pending-${slot.id}`)).toHaveTextContent(/Pending determination/);
    expect(screen.getByTestId(`slot-inherited-${slot.id}`)).toHaveTextContent(/Approval kept/);
    expect(screen.getByTestId(`slot-shared-${slot.id}`)).toHaveTextContent('Same document as task B2: one file is enough · filled there');
  });
});

describe('P6: settings and the severity catalogue (mock contract)', () => {
  it('the admin changes the EXIF tolerance and adds a severity; a stale version is refused', async () => {
    await signIn('pm');
    const s = await api.get<DocumentsQcSettings>('/settings/documents-qc');
    expect(s).toMatchObject({ new_version_inherit: false, exif_tolerance_hours: 24 });
    const s2 = await api.put<DocumentsQcSettings>('/settings/documents-qc', { version: s.version, body: { reason: 'camera clocks drift', exif_tolerance_hours: 48 } });
    expect(s2.exif_tolerance_hours).toBe(48);
    await expect(api.put('/settings/documents-qc', { version: s.version, body: { reason: 'stale', exif_tolerance_hours: 12 } })).rejects.toMatchObject({ status: 412 });
    await expect(api.put('/settings/documents-qc', { version: s2.version, body: { reason: 'bad', scan_off: true } })).rejects.toMatchObject({ status: 422 });
    const sev = await api.get<SnagSeverityList>('/snag-severities');
    const next = await api.put<SnagSeverityList>('/snag-severities', { version: sev.version, body: { reason: 'cosmetic defects', items: [...sev.items, { code: 'COSMETIC', name_en: 'Cosmetic', name_ar: 'تجميلية', blocks: false }] } });
    expect(next.items.map((x) => x.code)).toContain('COSMETIC');
    await expect(api.put('/snag-severities', { version: next.version, body: { reason: 'drop one', items: next.items.slice(1) } })).rejects.toMatchObject({ status: 422 });
  });
});
