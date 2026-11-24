import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useCatalogue as usePermissionCatalogue } from '@/api/admin';
import { API_BASE } from '@/api/client';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SETTINGS_TABS, SettingsRoutes } from './settings/Settings';

/**
 * W4 of the 2026-11-23 plan (owner image 6): Settings > Alerts and Settings > Security stayed on "Loading..." for ever. The screens returned "Loading..."
 * whenever their data was missing, so a refused read (403, for example a delegate of admin.settings on the staff visibility) or a route the server did
 * not serve yet (hybrid mode: 501 not_available) never ended. This guard renders every Settings tab and section, taken from SETTINGS_TABS so a new
 * one is covered at once, and fails if any of them still shows "Loading..." once its queries have settled: with the served data, and with every read
 * refused or not available as the hybrid build can answer.
 */
const PATHS = SETTINGS_TABS.flatMap((tab) => (tab.sections.length ? tab.sections.map((s) => `${tab.key}/${s.key}`) : [tab.key]));

/** The session and /me keep working, so the frame and the section navigation render; every other read answers the given status. */
const KEEP = [/\/__mock\//, /\/auth\/session$/, /\/me$/];
function answerAll(status: 403 | 501) {
  const problem = status === 403
    ? { type: 'about:blank', title: 'Forbidden', status, code: 'module_forbidden', detail: 'You cannot use this screen.' }
    : { type: 'about:blank', title: 'Not available yet', status, code: 'not_available', detail: 'This screen is not connected to the server yet. Nothing was read or saved.' };
  server.use(http.get(`${API_BASE}/*`, ({ request }) => {
    const path = new URL(request.url).pathname;
    if (KEEP.some((k) => k.test(path))) return undefined;
    return HttpResponse.json(problem, { status, headers: { 'Content-Type': 'application/problem+json' } });
  }));
}

/** "Loading..." in either locale, a busy marker, or a lone ellipsis placeholder. */
function stillLoading(): string | null {
  const text = document.body.textContent ?? '';
  if (/Loading…|جارٍ التحميل…/.test(text)) return 'the text "Loading..."';
  if (document.querySelector('[aria-busy="true"]')) return 'a busy marker';
  const lone = [...document.querySelectorAll('main *, body *')].find((el) => el.children.length === 0 && el.textContent?.trim() === '…');
  return lone ? 'a lone "…" placeholder' : null;
}

async function settle(qc: ReturnType<typeof renderApp>['qc']) {
  // twice: a screen may start a second read when the first one answers
  for (let i = 0; i < 3; i++) {
    await waitFor(() => expect(qc.isFetching()).toBe(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 30));
  }
}

const render = (path: string) => renderApp(<Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes>, { route: `/admin/settings/${path}` });

describe('W4 guard: no Settings tab or section stays on "Loading..."', () => {
  it('covers every tab and section of SETTINGS_TABS', () => {
    expect(PATHS).toContain('alerts');
    expect(PATHS).toContain('security/staff');
    expect(PATHS).toContain('security/retention');
    expect(PATHS.length).toBeGreaterThanOrEqual(20);
  });

  describe.each(PATHS)('%s', (path) => {
    it('renders once its reads answer', async () => {
      await signIn('pm');
      const { qc } = render(path);
      await screen.findByTestId('page-settings');
      await settle(qc);
      expect(stillLoading()).toBeNull();
    }, 30_000);

    it.each([403, 501] as const)('ends in a clear state when every read answers %s', async (status) => {
      await signIn('pm');
      answerAll(status);
      const { qc } = render(path);
      await screen.findByTestId('page-settings');
      await settle(qc);
      expect(stillLoading()).toBeNull();
    }, 30_000);
  });
});

describe('W4: Settings > Alerts and Settings > Security say why they cannot render', () => {
  it.each(['alerts', 'security/staff', 'security/retention'])('%s: a refused read says "no access", a missing route says "not available"', async (path) => {
    await signIn('pm');
    answerAll(403);
    const first = render(path);
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(stillLoading()).toBeNull();
    first.unmount();
    server.resetHandlers();
    answerAll(501);
    render(path);
    expect(await screen.findByText('Not available yet')).toBeInTheDocument();
    expect(screen.getByText(/not connected to the server yet/)).toBeInTheDocument();
    expect(stillLoading()).toBeNull();
  }, 30_000);

  it('Alerts works after a screen that read the permission catalogue (the two catalogues shared one query key)', async () => {
    await signIn('pm');
    function PermissionCatalogue() { usePermissionCatalogue(); return null; }
    renderApp(<><PermissionCatalogue /><Routes><Route path="/admin/settings/*" element={<SettingsRoutes />} /></Routes></>, { route: '/admin/settings/alerts' });
    expect(await screen.findByTestId('page-notifications')).toBeInTheDocument();
    expect((await screen.findAllByTestId(/^np-row-/)).length).toBeGreaterThan(0);
  }, 30_000);
});
