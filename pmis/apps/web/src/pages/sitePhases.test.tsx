import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import type { SiteTasks, StreamStatus } from '@/api/types';
import { phaseEmpty, phaseFromUrl, phaseQuery, sitePhases } from '@/lib/sitePhases';
import { DEFAULT_STREAMS } from '@/lib/streams';
import { server } from '@/mocks/server';
import { siteIdOf, STREAMS, VIEW_REFS, VIEWS } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { Site } from './Site';

// W1 (2026-11-23): the site page has one phase row, its phases taken from the site's published workflow version.
beforeEach(() => localStorage.setItem('pmis.site.layout', '"list"'));

const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
const labels = () => within(screen.getByTestId('site-phase-tabs')).getAllByRole('tab').map((x) => x.textContent);
const selected = () => within(screen.getByTestId('site-phase-tabs')).getAllByRole('tab').filter((x) => x.getAttribute('aria-selected') === 'true').map((x) => x.dataset.testid);
// SB107 (mock index 6) is an expansion site without adaption work: the whole Civil Works stream is N/A there
const NO_CW = siteIdOf(6);

describe('sitePhases (the phase list of the workflow version)', () => {
  it('merges the streams and the views in their configured order; a view with the code of a stream is that stream', () => {
    const p = sitePhases(STREAMS, VIEW_REFS);
    expect(p.map((x) => x.code)).toEqual(['DESIGN_ACQ', 'CW', 'TE', 'OM', 'CLOSURE', 'DISMANTLE']);
    expect(p.find((x) => x.code === 'CW')).toMatchObject({ stream: { code: 'CW' }, view: { code: 'CW' }, placeholder: false });
    expect(p.find((x) => x.code === 'OM')).toMatchObject({ stream: null, view: { code: 'OM' } });
    expect(p.find((x) => x.code === 'DISMANTLE')).toMatchObject({ stream: null, view: null, placeholder: true });
  });

  it('follows another configuration, nothing is hard-coded', () => {
    const streams = [{ ...STREAMS[3], sort_order: 1 }, { ...STREAMS[0], sort_order: 2 }, { code: 'DISMANTLE', name_en: 'Dismantle', name_ar: null, sort_order: 3 }];
    const views = [{ code: 'OM', name_en: 'O&M', name_ar: null, sort_order: 1 }, { code: 'QA', name_en: 'Quality', name_ar: null, sort_order: 2 }];
    const p = sitePhases(streams, views);
    expect(p.map((x) => x.code)).toEqual(['CLOSURE', 'DESIGN_ACQ', 'DISMANTLE', 'OM', 'QA']); // the first view-only phase goes after the streams
    expect(p.find((x) => x.code === 'DISMANTLE')?.placeholder).toBe(false); // the version has a real Dismantle stream
    expect(sitePhases(undefined, undefined).map((x) => x.code)).toEqual([...DEFAULT_STREAMS.map((x) => x.code), 'DISMANTLE']);
  });

  it('reads old links and builds the grid query of a phase', () => {
    const p = sitePhases(STREAMS, VIEW_REFS);
    expect(phaseFromUrl(p, 'TE', '')?.code).toBe('TE');
    expect(phaseFromUrl(p, '', 'CW')?.code).toBe('CW');
    expect(phaseFromUrl(p, 'CW', 'TE')?.code).toBe('CW');
    expect(phaseFromUrl(p, 'NOPE', '')).toBeNull();
    expect(phaseQuery(phaseFromUrl(p, '', 'CW'))).toEqual({ stream: 'CW', view: null });
    expect(phaseQuery(phaseFromUrl(p, '', 'OM'))).toEqual({ stream: null, view: 'OM' });
    expect(phaseQuery(phaseFromUrl(p, 'DISMANTLE', ''))).toEqual({ stream: null, view: null });
  });

  it('a phase without an applicable task is empty', () => {
    const p = sitePhases(STREAMS, VIEW_REFS), om = p.find((x) => x.code === 'OM')!;
    const status = (state: StreamStatus['state']) => [{ ...STREAMS[1], state, done_tasks: 0, total_tasks: 0, late_count: 0 }];
    expect(phaseEmpty(p[1], status('na'), undefined)).toBe(true);
    expect(phaseEmpty(p[1], status('in_progress'), undefined)).toBe(false);
    const grid = (state: string): SiteTasks => ({ workflow_version: 1, views: VIEWS, stages: [{ code: 'final_closure', name_en: 'Final Closure', tasks: [{ task_code: 'B14', state } as never] }] });
    expect(phaseEmpty(om, undefined, undefined)).toBe(false); // not known yet: stays enabled
    expect(phaseEmpty(om, undefined, grid('na'))).toBe(true);
    expect(phaseEmpty(om, undefined, grid('open'))).toBe(false);
    expect(phaseEmpty(p[p.length - 1], undefined, undefined)).toBe(true);
  });
});

describe('Site page: one phase row', () => {
  it('shows one row with the phases in workflow order and no duplicated label, in English and Arabic', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}` });
    await screen.findByTestId('site-phase-tabs');
    expect(labels()).toEqual(['All', 'Design & Acquisition', 'Civil Works', 'Installation (TE)', 'O&M', 'Handover & Closure', 'Dismantle']);
    expect(new Set(labels()).size).toBe(labels().length);
    expect(screen.queryByTestId('site-stream-tabs')).toBeNull();
    expect(screen.queryByTestId('site-view-tabs')).toBeNull();
    expect(screen.getAllByRole('tablist').filter((x) => x.dataset.testid !== 'site-section-tabs')).toHaveLength(1);
    expect(selected()).toEqual(['site-phase-tab-ALL']);
    cleanup();
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}`, locale: 'ar' });
    await screen.findByTestId('site-phase-tabs');
    expect(labels()).toEqual(['الكل', 'التصميم والاستحواذ', 'الأعمال المدنية', 'التركيبات', 'التشغيل والصيانة', 'التسليم والإغلاق', 'الفك']);
    expect(screen.getByTestId('site-phase-tabs')).toHaveAttribute('aria-label', 'المراحل');
  });

  it('a phase with no task for the site is disabled with a tooltip and cannot be opened; Dismantle too', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${NO_CW}` });
    const cw = await screen.findByTestId('site-phase-tab-CW');
    await waitFor(() => expect(cw).toHaveAttribute('aria-disabled', 'true'));
    expect(cw).toHaveAttribute('title', 'No task of this phase applies to this site.');
    await userEvent.click(cw);
    expect(selected()).toEqual(['site-phase-tab-ALL']);
    expect(screen.getByTestId('site-phase-tab-DISMANTLE')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('site-phase-tab-TE')).not.toHaveAttribute('aria-disabled');
    await waitFor(() => expect(screen.getByTestId('site-phase-tab-OM')).not.toHaveAttribute('aria-disabled'));
    // an old link to the empty phase still opens it, with the "does not apply" note instead of an empty grid
    cleanup();
    renderApp(<SiteAt />, { route: `/sites/${NO_CW}?stream=CW` });
    expect(await screen.findByTestId('site-stream-na')).toHaveTextContent('This phase does not apply to this site.');
    expect(selected()).toEqual(['site-phase-tab-CW']);
  });

  it('old stream= and view= links open the matching phase; a click writes the phase and fetches its tasks', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/tasks') && u.pathname.includes('/sites/')) seen.push(u.search); });
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}?stream=TE` });
    expect(await screen.findByTestId('grid-stage-te_installation')).toBeInTheDocument();
    expect(selected()).toEqual(['site-phase-tab-TE']);
    expect(screen.getByTestId('site-stream-summary')).toBeInTheDocument();
    cleanup();
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}?view=CW` });
    expect(await screen.findByTestId('grid-stage-cw')).toBeInTheDocument();
    expect(selected()).toEqual(['site-phase-tab-CW']);
    await waitFor(() => expect(seen).toContain('?stream=CW'));
    await userEvent.click(screen.getByTestId('site-phase-tab-OM'));
    expect(await screen.findByTestId('grid-stage-final_closure')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('grid-stage-cw')).toBeNull());
    expect(seen).toContain('?view=OM');
    expect(screen.queryByTestId('site-stream-summary')).toBeNull(); // O&M is not a stream
    expect(await screen.findAllByTestId(/^pipe-node-/)).toHaveLength(1);
    await userEvent.click(screen.getByTestId('site-phase-tab-ALL'));
    expect(await screen.findByTestId('grid-stage-cw')).toBeInTheDocument();
    expect(await screen.findAllByTestId(/^pipe-node-/)).toHaveLength(10);
  });

  it('the stream summary sits under the single row and follows the selected phase', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}` });
    await screen.findByTestId('site-phase-tabs');
    expect(screen.queryByTestId('site-stream-summary')).toBeNull();
    await userEvent.click(screen.getByTestId('site-phase-tab-DESIGN_ACQ'));
    const sum = await screen.findByTestId('site-stream-summary');
    expect(screen.getByTestId('site-phase-tabs').compareDocumentPosition(sum) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sum).toHaveTextContent(/of \d+ tasks done/);
  });

  it('the arrow keys move between the enabled phases, mirrored in RTL', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${NO_CW}` });
    const all = await screen.findByTestId('site-phase-tab-ALL');
    await waitFor(() => expect(screen.getByTestId('site-phase-tab-CW')).toHaveAttribute('aria-disabled', 'true'));
    all.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(selected()).toEqual(['site-phase-tab-DESIGN_ACQ']);
    await userEvent.keyboard('{ArrowRight}'); // Civil Works is disabled on this site: skipped
    expect(selected()).toEqual(['site-phase-tab-TE']);
    await userEvent.keyboard('{ArrowLeft}');
    expect(selected()).toEqual(['site-phase-tab-DESIGN_ACQ']);
    cleanup();
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(0)}`, locale: 'ar' });
    (await screen.findByTestId('site-phase-tab-ALL')).focus();
    await userEvent.keyboard('{ArrowLeft}'); // RTL: Left moves forward
    expect(selected()).toEqual(['site-phase-tab-DESIGN_ACQ']);
  });
});
