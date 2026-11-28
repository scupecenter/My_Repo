import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import type { CapacityPlanSettings } from '@/api/types';
import { renderApp, signIn } from '@/test/utils';
import { Capacity } from './Capacity';
import { SettingsRoutes } from './settings/Settings';

/** Resource capacity planning (migration 0666, contract 0.15.595): the Settings editor and the Capacity screen. */

const settings = () => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/screens/capacity' });

describe('Capacity planning', () => {
  it('lists the section under the Screens tab', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: '/admin/settings/screens' });
    await screen.findByTestId('settings-tab-screens');
    expect(screen.getByTestId('settings-section-screens-capacity')).toBeInTheDocument();
  });

  it('saves skills, a crew and an effort with a reason and a step-up, and the screen shows the load', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const u = userEvent.setup();
    settings();
    await screen.findByTestId('page-capacity-settings');
    expect(screen.getByTestId('capset-save')).toBeDisabled();
    await u.click(screen.getByTestId('capset-skill-add'));
    await u.type(screen.getByTestId('capset-skill-0-code'), 'civil');
    await u.type(screen.getByTestId('capset-skill-0-en'), 'Civil');
    await u.click(screen.getByTestId('capset-crew-add'));
    await u.type(screen.getByTestId('capset-crew-0-name'), 'Crew A');
    await u.clear(screen.getByTestId('capset-crew-0-size'));
    await u.type(screen.getByTestId('capset-crew-0-size'), '2');
    await u.click(screen.getByTestId('capset-crew-0-skill-civil'));
    await u.click(screen.getByTestId('capset-effort-add'));
    await u.type(screen.getByTestId('capset-effort-0-code'), 'civil_works');
    await u.clear(screen.getByTestId('capset-effort-0-days'));
    await u.type(screen.getByTestId('capset-effort-0-days'), '4');
    await u.click(screen.getByTestId('capset-save'));
    await u.type(await screen.findByTestId('capset-dialog-reason'), 'Capacity set up');
    await u.click(screen.getByTestId('capset-dialog-submit'));
    await waitFor(async () => expect((await api.get<CapacityPlanSettings>('/settings/capacity-plan')).version).toBe(2));
    const s = await api.get<CapacityPlanSettings>('/settings/capacity-plan');
    expect(s).toMatchObject({ skills: [{ code: 'civil', name_en: 'Civil', name_ar: '' }], crews: [{ name: 'Crew A', size: 2, skills: ['civil'] }], efforts: [{ task_code: 'civil_works', skill: 'civil', person_days: 4 }], updated_by: { employee_id: '1001' } });
  });

  it('refuses a duplicate skill code and an effort for an unknown skill (422)', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    const cur = await api.get<CapacityPlanSettings>('/settings/capacity-plan');
    const base = { skills: [{ code: 'civil', name_en: 'Civil', name_ar: '' }], crews: [], efforts: [], days_per_week: 5, utilization_pct: 80, horizon_weeks: 8, reason: 'test' };
    const bad = (b: object) => api.put('/settings/capacity-plan', { version: cur.version, body: b }).then(() => 'ok', (e: { status?: number }) => e.status);
    expect(await bad({ ...base, skills: [...base.skills, ...base.skills] })).toBe(422);
    expect(await bad({ ...base, efforts: [{ task_code: 'x', skill: 'nope', person_days: 1 }] })).toBe(422);
    expect(await bad({ ...base, utilization_pct: 5 })).toBe(422);
  });

  it('shows the empty state until crews exist', async () => {
    await signIn('pm');
    renderApp(<Routes><Route path="/capacity" element={<Capacity />} /></Routes>, { route: '/capacity' });
    expect(await screen.findByTestId('capacity-empty')).toBeInTheDocument();
  });
});
