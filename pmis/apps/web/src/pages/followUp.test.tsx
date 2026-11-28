import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import type { MyProfile } from '@/api/profile';
import { FollowUp, profileChecklist } from '@/pages/FollowUp';
import { renderApp, signIn } from '@/test/utils';

const base = { phone: null, ui_prefs: {}, ui_brand: null, local_sign_in: true, two_factor: { state: 'off' } } as unknown as MyProfile;
const opts = { notifications: { allowed: true, chosen: false }, push: { enabled: true, has: false } };

describe('profileChecklist', () => {
  it('lists every item that applies and marks what is done', () => {
    const l = profileChecklist({ ...base, phone: '+218910000000' }, opts);
    expect(l.map((i) => i.key)).toEqual(['phone', 'appearance', 'notifications', 'push', 'two_factor']);
    expect(l.find((i) => i.key === 'phone')?.done).toBe(true);
    expect(l.find((i) => i.key === 'push')?.to).toBe('/profile#push');
  });
  it('drops items that do not apply to this person', () => {
    const l = profileChecklist({ ...base, local_sign_in: false }, { notifications: { allowed: false, chosen: false }, push: { enabled: false, has: false } });
    expect(l.map((i) => i.key)).toEqual(['phone', 'appearance']);
  });
});

describe('Follow-up hub', () => {
  it('shows the four blocks and the checklist, and hides the checklist by the appearance choice', async () => {
    await signIn('pm');
    renderApp(<FollowUp />);
    expect(await screen.findByTestId('fup-approvals')).toBeInTheDocument();
    expect(screen.getByTestId('fup-assigned')).toBeInTheDocument();
    expect(screen.getByTestId('fup-reminders')).toBeInTheDocument();
    expect(await screen.findByTestId('fup-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('fup-check-phone')).toBeInTheDocument();
    expect(screen.getByTestId('fup-checklist-progress')).toHaveTextContent(/\d/);
  });
  it('hide: the checklist is gone', async () => {
    await signIn('pm');
    const prof = await api.get<{ version: number }>('/me/profile');
    await api.patch('/me/profile', { body: { ui_prefs: { followup_checklist: 'hide' } }, version: prof.version });
    renderApp(<FollowUp />);
    await screen.findByTestId('fup-approvals');
    await waitFor(() => expect(screen.queryByTestId('fup-checklist')).toBeNull());
    void userEvent;
  });
});
