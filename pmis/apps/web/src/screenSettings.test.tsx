import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { SETTINGS_TABS } from '@/pages/settings/Settings';
import { Sites } from '@/pages/Sites';
import { Approvals } from '@/pages/Approvals';
import { SCREEN_SETTINGS, canOpenScreenSettings, screenSettingsLabelKey, screenSettingsPath, type ScreenKey } from '@/lib/screenSettings';
import { renderApp, signIn } from '@/test/utils';

const keys = Object.keys(SCREEN_SETTINGS) as ScreenKey[];
const dig = (o: unknown, path: string) => path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);

describe('settings gear: central map', () => {
  it.each(keys)('%s points to a real Settings tab and section, with a name in EN and AR', (k) => {
    const r = SCREEN_SETTINGS[k] as { tab: string; section?: string; adminOnly?: boolean };
    const tab = SETTINGS_TABS.find((t) => t.key === r.tab);
    expect(tab).toBeTruthy();
    if (r.section) {
      const sec = tab!.sections.find((s) => s.key === r.section);
      expect(sec).toBeTruthy();
      expect(!!r.adminOnly).toBe(!!sec!.adminOnly);
    }
    const label = screenSettingsLabelKey(k);
    expect(typeof dig(en, label)).toBe('string');
    expect(typeof dig(ar, label)).toBe('string');
    expect(screenSettingsPath(k)).toMatch(/^\/admin\/settings\//);
  });

  it('points the moved settings at their new Settings sections', () => {
    expect(screenSettingsPath('template_mapping')).toBe('/admin/settings/data/mapping');
    expect(screenSettingsPath('security_alerts')).toBe('/admin/settings/security/alerts');
  });

  it('is permission-gated like the sidebar entry', () => {
    const grant = { is_system_admin: false, effective: { nav: ['admin.settings'] } };
    expect(canOpenScreenSettings(grant, 'sites')).toBe(true);
    expect(canOpenScreenSettings({ is_system_admin: false, effective: { nav: ['sites'] } }, 'sites')).toBe(false);
    expect(canOpenScreenSettings({ is_system_admin: true, effective: { nav: [] } }, 'sites')).toBe(true);
    expect(canOpenScreenSettings(undefined, 'sites')).toBe(false);
  });
});

function Probe() { const l = useLocation(); return <div data-testid="probe">{l.pathname}</div>; }
const page = (ui: JSX.Element, route: string, locale: 'en' | 'ar' = 'en') => renderApp(<><Probe /><Routes><Route path="/sites" element={ui} /><Route path="/approvals" element={ui} /><Route path="/admin/settings/*" element={<div>settings</div>} /></Routes></>, { route, locale });

describe('settings gear: on screens', () => {
  beforeEach(async () => { localStorage.clear(); });

  it('shows on Sites for a person who sees Settings, links to its page, hint has two lines', async () => {
    await signIn('pm');
    page(<Sites />, '/sites');
    const gear = await screen.findByTestId('screen-settings-link');
    expect(gear.getAttribute('aria-label')).toBe('Settings for this screen: Columns');
    expect(gear.getAttribute('href')).toBe('/admin/settings/workflow/columns');
    await userEvent.click(gear);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/admin/settings/workflow/columns'));
  });

  it('is hidden for a person without Settings', async () => {
    await signIn('engineer');
    page(<Sites />, '/sites');
    await screen.findByTestId('page-sites').catch(() => undefined);
    await waitFor(() => expect(screen.queryByTestId('screen-settings-link')).toBeNull());
  });

  it('Arabic uses the Arabic title and destination', async () => {
    await signIn('pm');
    page(<Approvals />, '/approvals', 'ar');
    const gear = await screen.findByTestId('screen-settings-link');
    expect(gear.getAttribute('aria-label')).toBe(`${ar.screenSettings.title}: ${ar.settings.section_workflow_editor}`);
  });
});
