import { screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { SITE_DATA_SCREENS } from '@/lib/siteDataScreens';
import { Approvals } from './Approvals';
import { MyWork } from './MyWork';
import { RegisterPage } from './Register';
import { Site } from './Site';
import { Sites } from './Sites';

/**
 * W8 item 4 guard: every screen that shows site data renders the shared table toolbar (TableStandard.tsx) with saved views, search, + Filter,
 * the server count, Display and Export, plus the column chooser and density on a table with columns, and the # column where rows are shown.
 * A screen added to SITE_DATA_SCREENS as `done` without a case here fails too.
 */
const SITE = siteIdOf(0);
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
const Reg = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;

const CASES: Record<string, { ui: () => ReactElement; route: string; rows: boolean; before?: () => void }> = {
  'site-master': { ui: () => <Sites />, route: '/sites', rows: true },
  'site-master-stream': { ui: () => <Sites />, route: '/sites?stream=CW', rows: true },
  'site-master-view': { ui: () => <Sites />, route: '/sites?view=CW', rows: true },
  'site-master-menu': { ui: () => <Sites />, route: '/sites?section=cw', rows: true },
  'site-master-wide': { ui: () => <Sites />, route: '/sites?section=master&layout=wide', rows: false },
  'site-master-map': { ui: () => <Sites />, route: '/sites?layout=map', rows: false },
  'site-master-board': { ui: () => <Sites />, route: '/sites?layout=board', rows: false },
  'site-tasks': { ui: () => <SiteAt />, route: `/sites/${SITE}`, rows: true },
  'site-tasks-timeline': { ui: () => <SiteAt />, route: `/sites/${SITE}`, rows: false, before: () => localStorage.setItem('pmis.site.layout', '"timeline"') },
  registers: { ui: () => <Reg />, route: '/registers/procurement', rows: true },
  'my-work': { ui: () => <MyWork />, route: '/my-work', rows: true },
  approvals: { ui: () => <Approvals />, route: '/approvals', rows: true },
  'dashboard-drilldowns': { ui: () => <Sites />, route: '/sites?dashboard_status=in_progress&ref_date=2026-11-01', rows: true },
};

describe('W8 guard: the table standard on every site-data screen', () => {
  it('every screen marked done has a case here, and every not-applicable one says why', () => {
    for (const s of SITE_DATA_SCREENS) {
      if (s.state === 'done') expect(CASES[s.id], s.id).toBeDefined();
      else expect(s.note.length, s.id).toBeGreaterThan(10);
    }
  });

  for (const s of SITE_DATA_SCREENS.filter((x) => x.state === 'done')) {
    it(`${s.id}: the shared toolbar is complete and the count is there`, async () => {
      const c = CASES[s.id]!;
      c.before?.();
      await signIn('pm');
      const { container } = renderApp(c.ui(), { route: c.route });
      // a screen may mount its saved views and filter once its first page has settled (registers): wait for the whole toolbar
      await waitFor(() => expect(container.querySelector('[data-table-standard][data-has-views][data-has-filter]')).not.toBeNull(), { timeout: 4000 });
      const bar = container.querySelector('[data-table-standard]')!;
      expect(bar.getAttribute('data-table-standard')).toBe(s.kind ?? 'grid');
      for (const a of ['data-has-search', 'data-has-filter', 'data-has-views', 'data-has-display', 'data-has-export']) expect(bar.hasAttribute(a), `${s.id} ${a}`).toBe(true);
      if ((s.kind ?? 'grid') === 'grid' && s.id !== 'site-master-map' && s.id !== 'site-master-board') {
        for (const a of ['data-has-columns', 'data-has-density']) expect(bar.hasAttribute(a), `${s.id} ${a}`).toBe(true);
      }
      expect(bar.querySelector('[data-table-count]'), `${s.id} count`).not.toBeNull();
      if (c.rows) await waitFor(() => expect(screen.getAllByTestId('row-no').length, `${s.id} #`).toBeGreaterThan(0), { timeout: 4000 });
    }, 15_000);
  }
});
