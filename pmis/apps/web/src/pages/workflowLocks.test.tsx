import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import type { Page, SiteDetail, SiteDraft, SiteListItem } from '@/api/types';
import { HistoricalLoadOption } from '@/components/HistoricalLoadOption';
import { OverrideBadge } from '@/components/OverrideBadge';
import { ImportSitesPanel } from '@/components/WorkflowLocks';
import ar from '@/i18n/ar.json';
import en from '@/i18n/en.json';
import { siteIdOf, siteMeta } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { NewSite } from './NewSite';
import { Site } from './Site';
import { Sites } from './Sites';

/** Contract 0.15.4 (migration 0085): the per-site workflow locks (chip and switch, SITE 360 column, filter and bulk action, the New site field) and the sites of an import. */
const T = 30_000;
const stepUpDone = () => api.post('/__mock/step-up');
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
const Routed = () => <Routes><Route path="/sites" element={<Sites />} /><Route path="/sites/new" element={<NewSite />} /></Routes>;
const errCode = async (p: Promise<unknown>) => p.then(() => null, (e: ApiError) => `${e.status}:${e.code}`);

describe('the site page: Locks chip and switch', () => {
  it('shows "Locks: on"; a System Admin opens them with a reason and a step-up, and the chip turns to off', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const id = siteIdOf(0);
    renderApp(<SiteAt />, { route: `/sites/${id}` });
    const chip = await screen.findByTestId('site-locks-chip');
    expect(chip).toHaveAttribute('data-locked', 'true');
    expect(chip).toHaveTextContent('Locks: on');
    await u.click(screen.getByTestId('site-locks-toggle'));
    const dlg = await screen.findByTestId('site-locks-dialog');
    expect(within(dlg).getByTestId('site-locks-dialog-note')).toHaveTextContent(/Admin override/);
    await u.click(within(dlg).getByTestId('site-locks-dialog-submit'));                 // a reason is required
    expect(await within(dlg).findByTestId('site-locks-dialog-reason-error')).toBeInTheDocument();
    await u.type(within(dlg).getByTestId('site-locks-dialog-reason'), 'Historical site, entered in any order');
    await stepUpDone();
    await u.click(within(dlg).getByTestId('site-locks-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('site-locks-chip')).toHaveAttribute('data-locked', 'false'));
    expect(screen.getByTestId('site-locks-chip')).toHaveTextContent('Locks: off');
    expect((await api.get<SiteDetail>(`/sites/${id}`)).workflow_locks).toBe(false);
  }, T);

  it('shows the chip without the switch to someone who may not change it, and the server refuses them (403); a missing reason is 422', async () => {
    await signIn('engineer'); await stepUpDone();
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(1)}` });
    expect(await screen.findByTestId('site-locks-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('site-locks-toggle')).not.toBeInTheDocument();
    expect(await errCode(api.put(`/sites/${siteIdOf(1)}/workflow-locks`, { body: { locked: false, reason: 'Not mine to change' } }))).toBe('403:action_forbidden');
    await signIn('pm'); await stepUpDone();
    expect(await errCode(api.put(`/sites/${siteIdOf(1)}/workflow-locks`, { body: { locked: false, reason: 'x' } }))).toBe('422:validation_failed');
  }, T);

  it('shows the data gaps of a site', async () => {
    await signIn('pm');
    renderApp(<SiteAt />, { route: `/sites/${siteIdOf(3)}` });   // the mock gives every seventh site two gaps
    const g = await screen.findByTestId('site-data-gaps');
    expect(g).toHaveTextContent('2 data gaps');
    expect(g.getAttribute('title')).toMatch(/B3 has no actual date while B4 has one/);
  }, T);
});

describe('SITE 360: the column, the filter and the bulk action', () => {
  it('shows the Workflow locks column, filters on Open, and opens the locks of the selected sites with one reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Routed />, { route: '/sites' });
    const a = siteMeta(0).code, b = siteMeta(1).code;
    expect(await screen.findByTestId(`site-locks-${a}`)).toHaveTextContent('Locked');
    await u.click(screen.getByTestId(`site-select-${a}`));
    await u.click(screen.getByTestId(`site-select-${b}`));
    await u.click(screen.getByTestId('sites-bulk-locks-open'));
    const dlg = await screen.findByTestId('sites-locks-dialog');
    expect(dlg).toHaveTextContent('Open the workflow locks of 2 sites');
    await u.type(within(dlg).getByTestId('sites-locks-dialog-reason'), 'Both sites are historical');
    await stepUpDone();
    await u.click(within(dlg).getByTestId('sites-locks-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('sites-locks-dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId(`site-locks-${a}`)).toHaveTextContent('Open'));
    expect(screen.getByTestId(`site-locks-${b}`)).toHaveTextContent('Open');

    await u.selectOptions(screen.getByTestId('sites-filter-locks'), 'open');
    await waitFor(() => expect(screen.getByTestId('sites-count')).toHaveTextContent(/^2 /));
    const open = await api.get<Page<SiteListItem>>('/sites', { query: { workflow_locks: 'open' } });
    expect(open.items.map((x) => x.site_code).sort()).toEqual([a, b].sort());
  }, T);

  it('keeps the sites with data gaps with the quick filter, and hides the bulk switch from someone without the right', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    renderApp(<Routed />, { route: '/sites' });
    await screen.findByTestId(`site-row-${siteMeta(0).code}`);
    await u.click(screen.getByTestId('sites-quick-gaps'));
    await waitFor(() => expect(screen.getByTestId(`site-gaps-${siteMeta(3).code}`)).toHaveTextContent('2'));
    expect(screen.queryByTestId(`site-row-${siteMeta(0).code}`)).not.toBeInTheDocument();
    await u.click(screen.getByTestId(`site-select-${siteMeta(3).code}`));
    expect(screen.queryByTestId('sites-bulk-locks-open')).not.toBeInTheDocument();
  }, T);
});

describe('New site: the Workflow locks field', () => {
  it('is Locked by default; Open shows the hint and goes with the draft', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    renderApp(<Routed />, { route: '/sites/new' });
    const sel = await screen.findByTestId('ns-workflow_locks');
    expect(sel).toHaveValue('');
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['Locked (default)', 'Open']);
    await u.type(screen.getByTestId('ns-site_code'), 'WL-OPEN-1');
    await u.selectOptions(screen.getByTestId('ns-region_id'), '1');
    await u.type(screen.getByTestId('ns-name'), 'Open site');
    await u.selectOptions(sel, 'Open');
    expect(screen.getByTestId('ns-workflow-locks-hint')).toHaveTextContent(/delegated right to unlock/);
    await u.click(screen.getByTestId('ns-save'));
    await screen.findByTestId('ns-draft-WL-OPEN-1');
    const list = await api.get<Page<SiteDraft>>('/site-drafts');
    expect(list.items.find((d) => d.site_code === 'WL-OPEN-1')?.data).toMatchObject({ workflow_locks: 'open' });
  }, T);
});

describe('the sites of an import and the historical option', () => {
  it('lists every site with its status and missing data, filters to the incomplete ones, and locks them again', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<ImportSitesPanel source="run" id="7a000000-0000-4000-8000-000000000001" canManage />);
    expect(await screen.findByTestId(`import-site-${siteMeta(0).code}`)).toBeInTheDocument();
    expect(screen.getByTestId(`import-site-missing-${siteMeta(3).code}`)).toHaveTextContent('3 warning(s), 2 gap(s)');
    await u.click(screen.getByTestId('import-sites-gaps-only'));
    await waitFor(() => expect(screen.queryByTestId(`import-site-${siteMeta(1).code}`)).not.toBeInTheDocument());
    expect(screen.getByTestId(`import-site-${siteMeta(3).code}`)).toBeInTheDocument();
    // open one site, then lock every site of the run again with one reason
    await stepUpDone();
    await api.put(`/sites/${siteIdOf(3)}/workflow-locks`, { body: { locked: false, reason: 'Historical load' } });
    await u.click(screen.getByTestId('import-sites-gaps-only'));
    await u.click(await screen.findByTestId('import-sites-lock-all'));
    await u.type(screen.getByTestId('import-sites-lock-dialog-reason'), 'The load is finished');
    await u.click(screen.getByTestId('import-sites-lock-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId(`import-site-locks-${siteMeta(3).code}`)).toHaveTextContent('Locks: on'));
  }, T);

  it('explains that the historical option opens the locks of the loaded sites', async () => {
    const u = userEvent.setup();
    let v = { on: false, reason: '' };
    const { rerender } = renderApp(<HistoricalLoadOption waiver={{ open: true, cutoff_date: '2026-02-28' } as never} value={v} onChange={(x) => { v = x; }} />);
    expect(screen.queryByTestId('hl-locks-note')).not.toBeInTheDocument();
    await u.click(screen.getByTestId('hl-toggle'));
    rerender(<HistoricalLoadOption waiver={{ open: true, cutoff_date: '2026-02-28' } as never} value={v} onChange={(x) => { v = x; }} />);
    expect(screen.getByTestId('hl-locks-note')).toHaveTextContent(/opens the workflow locks of every site of the file/);
  }, T);

  it('shows the Admin override badge of a lock bypass with the lock it bypassed, and has every text in English and Arabic', () => {
    renderApp(<OverrideBadge taskId="t1" bypass="predecessor_open:A1" />);
    const b = screen.getByTestId('override-t1');
    expect(b).toHaveAttribute('data-kind', 'lock_bypass');
    expect(b.getAttribute('title')).toMatch(/before A1/);
    const enKeys = Object.keys(en.locks).filter((k) => !/_(zero|two|few|many)$/.test(k)).sort();
    const arKeys = Object.keys(ar.locks).filter((k) => !/_(zero|two|few|many)$/.test(k)).sort();
    expect(arKeys).toEqual(enKeys);
    expect(ar.override.bypass_title).toBeTruthy();
  });
});
