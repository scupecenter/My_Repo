import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { CalendarConfirmation, Holiday, HolidaySummary, MailNotificationKinds } from '@/api/types';
import { renderApp, signIn } from '@/test/utils';
import { SettingsRoutes } from './settings/Settings';

/** Settings screens of Q440 (confirm the official calendar) and Q441 (the mail notification kinds), contract 0.14.2. */
const stepUpDone = () => api.post('/__mock/step-up');
const settings = (tab: string, opts = {}) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: `/admin/settings/${tab}`, ...opts });
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);
const errBody = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => e.problem.errors ?? []);
const reasonAndSave = async (u: ReturnType<typeof userEvent.setup>, dlg: string, reason = 'The ministry announced the dates') => {
  await u.type(await screen.findByTestId(`${dlg}-reason`), reason);
  await u.click(screen.getByTestId(`${dlg}-submit`));
};
/** Confirms every tentative holiday through the API, so that the calendar can be confirmed. */
async function confirmAllTentative(): Promise<void> {
  const list = await api.get<{ items: Holiday[] }>('/settings/holidays');
  for (const h of list.items.filter((x) => x.tentative)) {
    await api.post(`/settings/holidays/${h.id}/confirm`, { version: h.version, body: { reason: 'Official announcement' } });
  }
}

describe('Q440: confirm the official calendar (Settings, Work calendar)', () => {
  it('shows the banner and what blocks the confirmation; the button is off while a holiday is tentative', async () => {
    await signIn('pm');
    settings('calendar');
    expect(await screen.findByTestId('cal-not-confirmed')).toHaveTextContent('not confirmed');
    expect(screen.getByTestId('cal-banner-official')).toBeInTheDocument();
    expect(screen.getByTestId('cal-blockers')).toHaveTextContent(/still tentative/);
    expect(screen.getByTestId('cal-confirm-official')).toBeDisabled();
  });

  it('confirms with a reason: the banner goes, who and when are shown; then withdraws it and the banner returns', async () => {
    await signIn('pm');
    await confirmAllTentative();
    const u = userEvent.setup();
    settings('calendar');
    const btn = await screen.findByTestId('cal-confirm-official');
    await waitFor(() => expect(btn).toBeEnabled());
    expect(screen.queryByTestId('cal-blockers')).toBeNull();
    await u.click(btn);
    await u.click(await screen.findByTestId('cal-official-dialog-submit'));
    expect(await screen.findByTestId('cal-official-dialog-reason-error')).toBeInTheDocument();   // a reason is required
    await reasonAndSave(u, 'cal-official-dialog');
    expect(await screen.findByTestId('cal-confirmed-info')).toHaveTextContent(/Confirmed by .*\(1001\)/);
    await waitFor(() => expect(screen.queryByTestId('cal-banner-official')).toBeNull());
    const sum = (await api.get<{ summary: HolidaySummary }>('/settings/holidays')).summary;
    expect(sum).toMatchObject({ official_calendar_pending: false, official_confirmed_by: { employee_id: '1001' } });
    expect(sum.official_confirmed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await u.click(await screen.findByTestId('cal-unconfirm-official'));
    await reasonAndSave(u, 'cal-official-dialog', 'A date was announced again');
    expect(await screen.findByTestId('cal-banner-official')).toBeInTheDocument();
    expect(screen.getByTestId('cal-not-confirmed')).toBeInTheDocument();
  });

  it('the API asks for If-Match and a reason, refuses a stale version, a repeated state and a confirmation that is blocked; a user without the right gets 403', async () => {
    await signIn('pm');
    const cur = await api.get<CalendarConfirmation>('/settings/calendar-confirmation');
    expect(cur).toMatchObject({ confirmed: false, can_edit: true });
    expect(cur.blockers.map((b) => b.code)).toContain('tentative_remaining');
    expect(await errCode(api.put('/settings/calendar-confirmation', { body: { confirmed: true, reason: 'No tag here' } }))).toBe('428:precondition_required');
    expect(await errCode(api.put('/settings/calendar-confirmation', { version: cur.version + 7, body: { confirmed: true, reason: 'Stale tag here' } }))).toBe('412:precondition_failed');
    expect(await errCode(api.put('/settings/calendar-confirmation', { version: cur.version, body: { confirmed: true } }))).toBe('422:validation_failed');
    expect(await errBody(api.put('/settings/calendar-confirmation', { version: cur.version, body: { confirmed: true, reason: 'Too early for this' } })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '/confirmed', code: 'tentative_remaining' })]));
    expect(await errCode(api.put('/settings/calendar-confirmation', { version: cur.version, body: { confirmed: false, reason: 'Already not confirmed' } }))).toBe('409:invalid_transition');
    await signIn('engineer');
    const mine = await api.get<CalendarConfirmation>('/settings/calendar-confirmation');
    expect(mine.can_edit).toBe(false);
    expect(await errCode(api.put('/settings/calendar-confirmation', { version: mine.version, body: { confirmed: true, reason: 'I am not allowed' } }))).toBe('403:action_forbidden');
  });

  it('a user without the right sees the state but no button', async () => {
    await signIn('engineer');
    settings('calendar');
    expect(await screen.findByTestId('cal-confirmation')).toBeInTheDocument();
    expect(screen.queryByTestId('cal-confirm-official')).toBeNull();
    expect(screen.queryByTestId('cal-unconfirm-official')).toBeNull();
  });

  it('is in Arabic when the locale is Arabic', async () => {
    await signIn('pm');
    settings('calendar', { locale: 'ar' });
    expect(await screen.findByTestId('cal-not-confirmed')).toHaveTextContent('التقويم الرسمي غير مؤكَّد');
    expect(screen.getByTestId('cal-confirm-official')).toHaveTextContent('تأكيد التقويم الرسمي');
  });
});

describe('Q441: the mail notification kinds (Settings, Mail kinds)', () => {
  it('is a System Admin tab: the checklist lists the kinds of the code and marks the six go-live kinds as recommended', async () => {
    await signIn('pm');
    settings('mail-kinds');
    expect(await screen.findByTestId('page-mail-kinds')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-mail-kinds')).toHaveTextContent('Mail kinds');
    const six = ['task_assigned', 'register_assigned', 'snag_review', 'task_rejected', 'register_rejected', 'snag_rejected'];
    for (const k of six) expect(screen.getByTestId(`mail-kind-recommended-${k}`)).toHaveTextContent('Recommended');
    expect(screen.queryByTestId('mail-kind-recommended-mention')).toBeNull();
    expect(screen.getByTestId('mail-kind-mention')).not.toBeChecked();
    expect(screen.queryByTestId('mail-kind-security_alert')).toBeNull();                   // reserved kinds are not offered
    expect(screen.getByTestId('mail-kinds-save')).toBeDisabled();
  });

  it('selects the six recommended kinds, saves with a reason and a step-up, and the checklist keeps them', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    settings('mail-kinds');
    await u.click(await screen.findByTestId('mail-kinds-recommended'));
    expect(screen.getByTestId('mail-kind-task_assigned')).toBeChecked();
    expect(screen.getByTestId('mail-kinds-save')).toBeEnabled();
    await u.click(screen.getByTestId('mail-kind-mention'));
    await u.click(screen.getByTestId('mail-kind-mention'));                                  // off again
    await u.click(screen.getByTestId('mail-kinds-save'));
    await stepUpDone();
    await reasonAndSave(u, 'mail-kinds-dialog', 'Go-live list (Q250)');
    await waitFor(() => expect(screen.getByTestId('mail-kinds-save')).toBeDisabled());
    const saved = await api.get<MailNotificationKinds>('/settings/mail-notification-kinds');
    expect(saved.kinds).toEqual(['register_assigned', 'register_rejected', 'snag_rejected', 'snag_review', 'task_assigned', 'task_rejected']);
    expect(screen.getByTestId('mail-kind-snag_review')).toBeChecked();
    expect(screen.getByTestId('mail-kind-mention')).not.toBeChecked();
  });

  it('the API refuses unknown and reserved kinds, duplicates, a stale version and a missing step-up; everybody but a System Admin gets 403', async () => {
    await signIn('pm');
    const cur = await api.get<MailNotificationKinds>('/settings/mail-notification-kinds');
    expect(cur.catalogue.filter((c) => c.recommended)).toHaveLength(6);
    expect(await errCode(api.put('/settings/mail-notification-kinds', { version: cur.version, body: { kinds: ['task_assigned'], reason: 'No step-up yet' } }))).toBe('401:step_up_required');
    await stepUpDone();
    expect(await errCode(api.put('/settings/mail-notification-kinds', { body: { kinds: ['task_assigned'], reason: 'No tag here' } }))).toBe('428:precondition_required');
    expect(await errCode(api.put('/settings/mail-notification-kinds', { version: cur.version + 9, body: { kinds: ['task_assigned'], reason: 'Stale tag here' } }))).toBe('412:precondition_failed');
    const errs = await errBody(api.put('/settings/mail-notification-kinds', { version: cur.version, body: { kinds: ['task_assigned', 'made_up', 'security_alert', 'integrity_head', 'task_assigned'], reason: 'A mixed list' } }));
    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/kinds/1', code: 'unknown_kind' }), expect.objectContaining({ path: '/kinds/2', code: 'reserved_kind' }),
      expect.objectContaining({ path: '/kinds/3', code: 'reserved_kind' }), expect.objectContaining({ path: '/kinds/4', code: 'duplicate' }),
    ]));
    await signIn('engineer');
    expect(await errCode(api.get('/settings/mail-notification-kinds'))).toBe('403:action_forbidden');
    expect(await errCode(api.put('/settings/mail-notification-kinds', { version: 1, body: { kinds: [], reason: 'Not an admin' } }))).toBe('403:action_forbidden');
  });

  it('the tab is hidden from a user who is not a System Admin', async () => {
    await signIn('engineer');
    settings('calendar');
    expect(await screen.findByTestId('page-settings')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-calendar')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('settings-tab-mail-kinds')).toBeNull());
  });

  it('is in Arabic when the locale is Arabic', async () => {
    await signIn('pm');
    settings('mail-kinds', { locale: 'ar' });
    expect(await screen.findByTestId('page-mail-kinds')).toHaveTextContent('أنواع الإشعارات المرسلة بالبريد');
    expect(screen.getByTestId('mail-kind-recommended-task_assigned')).toHaveTextContent('موصى به');
    expect(screen.getByTestId('settings-tab-mail-kinds')).toHaveTextContent('أنواع البريد');
  });
});
