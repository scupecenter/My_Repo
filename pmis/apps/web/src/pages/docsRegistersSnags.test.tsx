import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { snagError } from '@/components/SiteSnags';
import { resetQcMocks, siteProposals } from '@/mocks/handlers.qc';
import { recId } from '@/mocks/registersData';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';
import { Site } from './Site';

/** Contract 0.11.1 (migration 0047): near_airport on the site (Q130), the Documents section of the register drawer (Q131) and QC snag photos (Q132). */
const SITE = siteIdOf(2);
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
const RegAt = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;
/** The mock has no EXIF reader: a photo whose bytes start with `exif:before` stands for one taken before the snag was raised. */
const jpg = (name = 'fix.jpg', body = 'jpeg body') => new File([body], name, { type: 'image/jpeg' });
const pdf = (name = 'permit.pdf') => new File(['%PDF-1.4 body'], name, { type: 'application/pdf' });

beforeEach(() => resetQcMocks());

describe('Q130: the site field near_airport', () => {
  it('shows the yes/no field on the site; since Q225 (contract 0.12.10) a change is proposed with a reason and the site keeps its value', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    const box = await screen.findByTestId('site-field-input-near_airport');
    expect(screen.getByTestId('site-fields')).toHaveTextContent('Near an airport');
    expect(screen.getByTestId('site-field-approval-near_airport')).toHaveTextContent('Needs approval');
    expect(box).not.toBeChecked();
    await u.click(box);
    const send = await screen.findByTestId('site-field-proposal-send');
    expect(send).toBeDisabled();                                                     // a reason is required
    await u.type(screen.getByTestId('site-field-proposal-reason'), 'airport survey');
    await u.click(send);
    expect(await screen.findByText(/Proposal SFC-NEAR_AIRPORT-1 created in Change Control/)).toBeInTheDocument();
    expect(siteProposals).toEqual([expect.objectContaining({ site_id: SITE, field: 'near_airport', old_value: '(none)', new_value: 'Yes', reason: 'airport survey' })]);
    await waitFor(() => expect(screen.getByTestId('site-field-input-near_airport')).not.toBeChecked());
    expect(screen.queryByTestId('site-field-proposal')).toBeNull();
  });

  it('is in Arabic in the Arabic interface', async () => {
    await signIn('engineer');
    renderApp(<SiteAt />, { route: `/sites/${SITE}`, locale: 'ar' });
    expect(await screen.findByTestId('site-field-near_airport')).toHaveTextContent('قريب من مطار');
    expect(screen.getByTestId('site-fields')).toHaveTextContent('بيانات الموقع');
  });
});

describe('Q131: the Documents section of the register drawer', () => {
  it('lists the record\'s slot, blocks Submit while the mandatory document is missing, and accepts a file into the slot', async () => {
    await signIn('pm');
    const u = userEvent.setup({ applyAccept: false });
    renderApp(<RegAt />, { route: `/registers/permits_hse?record=${recId(10)}` });
    const drawer = await screen.findByTestId('register-drawer-body');
    expect(await within(drawer).findByTestId('reg-docs-missing')).toHaveTextContent('PERMIT_SCAN');
    expect(within(drawer).getByTestId('reg-submit')).toBeDisabled();
    await u.click(within(drawer).getByRole('tab', { name: 'Documents' }));
    const list = await within(drawer).findByTestId('rec-docs');
    expect(within(list).getByTestId('rec-docs-missing')).toHaveTextContent('PERMIT_SCAN');
    const input = within(list).getAllByTestId(/^slot-input-/)[0] as HTMLInputElement;
    const id = input.dataset.testid!.replace('slot-input-', '');
    expect(within(list).getByTestId(`slot-status-${id}`)).toHaveTextContent('Missing');
    // a program is refused with its reason
    await u.upload(input, new File(['MZ'], 'virus.exe', { type: 'application/x-msdownload' }));
    expect(await screen.findByText(/virus\.exe: /)).toBeInTheDocument();
    await u.upload(input, pdf());
    await waitFor(() => expect(within(drawer).getByTestId(`slot-status-${id}`)).toHaveTextContent('Uploaded'));
    await waitFor(() => expect(within(drawer).queryByTestId('rec-docs-missing')).toBeNull());
    expect(within(drawer).getByTestId('reg-submit')).toBeEnabled();
  });

  it('an approved record shows its slots read-only', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<RegAt />, { route: `/registers/permits_hse?record=${recId(9)}` });
    const drawer = await screen.findByTestId('register-drawer-body');
    await u.click(within(drawer).getByRole('tab', { name: 'Documents' }));
    await within(drawer).findByTestId('rec-docs');
    expect(within(drawer).queryAllByTestId(/^slot-input-/)).toHaveLength(0);
  });
});

describe('Q132: QC snag photos', () => {
  it('the site engineer raises a snag, adds the photos of the fix by shot type and submits; L2 returns it with a note', async () => {
    await signIn('engineer');
    const u = userEvent.setup({ applyAccept: false });
    renderApp(<SiteAt />, { route: `/sites/${SITE}?tab=snags` });
    await u.click(await screen.findByTestId('snag-raise'));
    await u.selectOptions(await screen.findByTestId('snag-raise-type'), await screen.findByRole('option', { name: 'Concrete crack' }));
    await u.type(screen.getByTestId('snag-raise-title'), 'Crack at plinth');
    // a snag needs a severity (Q233, contract 0.12.4)
    expect(screen.getByTestId('snag-raise-send')).toBeDisabled();
    await u.selectOptions(screen.getByTestId('snag-raise-severity'), await screen.findByRole('option', { name: 'Major' }));
    await u.click(screen.getByTestId('snag-raise-send'));
    const card = (await screen.findAllByTestId(/^snag-[0-9a-f-]{36}$/))[0]!;
    const sid = card.dataset.testid!.replace('snag-', '');
    expect(screen.getByTestId(`snag-state-${sid}`)).toHaveTextContent('Open');
    expect(screen.getByTestId(`snag-rules-${sid}`)).toHaveTextContent(/2 photo\(s\) · JPG/);
    expect(screen.getByTestId(`snag-rules-${sid}`)).toHaveTextContent(/wide, close/);
    // a photo taken before the snag was raised is refused, with the reason
    await u.upload(screen.getByTestId(`snag-input-${sid}`), jpg('fix.jpg', 'exif:before the raise'));
    expect(await screen.findByText(/taken before the snag was raised/)).toBeInTheDocument();
    await u.upload(screen.getByTestId(`snag-input-${sid}`), jpg('wide.jpg'));
    await waitFor(() => expect(screen.getByTestId(`snag-photos-${sid}`).querySelectorAll('li[data-testid^="snag-photo-"]')).toHaveLength(1));
    // the mock photo has no EXIF date: the flag for L2
    expect(screen.getAllByTestId(/^snag-photo-unknown-/)).toHaveLength(1);
    expect(screen.queryByTestId(`snag-submit-${sid}`)).toBeNull();
    await u.selectOptions(screen.getByTestId(`snag-shot-${sid}`), 'close');
    await u.upload(screen.getByTestId(`snag-input-${sid}`), jpg('close.jpg'));
    await u.click(await screen.findByTestId(`snag-submit-${sid}`));
    await waitFor(() => expect(screen.getByTestId(`snag-state-${sid}`)).toHaveTextContent('Waiting for L2'));
    expect(screen.queryByTestId(`snag-input-${sid}`)).toBeNull();

    // L2 (the PM in the mock) sees approve and reject; a rejection needs a note and returns the snag to L1
    cleanup();
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${SITE}?tab=snags` });
    expect(await screen.findByTestId(`snag-approve-${sid}`)).toBeEnabled();
    await u.click(screen.getByTestId(`snag-reject-${sid}`));
    await u.type(await screen.findByTestId('reject-note'), 'close-up is blurred');
    await u.click(screen.getByTestId('reject-submit'));
    // the photos still meet the rules: back to L1 as "fix uploaded", with the note
    await waitFor(() => expect(screen.getByTestId(`snag-state-${sid}`)).toHaveTextContent('Fix uploaded'));
    expect(screen.getByTestId(`snag-return-${sid}`)).toHaveTextContent('close-up is blurred');
  });

  it('says why a photo was refused, in plain words', () => {
    const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? JSON.stringify(o) : ''}`;
    const err = (status: number, code: string, extra: Record<string, unknown> = {}) => new ApiError(status, { type: 'about:blank', title: 'x', status, code, ...extra } as never);
    expect(snagError(t, err(422, 'file_rejected', { reason: 'before_snag_raised' }))).toBe('snags.err.before_raised');
    expect(snagError(t, err(422, 'file_rejected', { reason: 'format_not_allowed', allowed: ['JPG'] }))).toBe('snags.err.format{"formats":"JPG"}');
    expect(snagError(t, err(413, 'file_too_large', { max_size_mb: 5 }))).toBe('snags.err.too_large{"mb":5}');
    expect(snagError(t, err(422, 'validation_failed', { errors: [{ path: '/photos', code: 'min_count' }] }))).toBe('snags.err.min_count');
  });
});
