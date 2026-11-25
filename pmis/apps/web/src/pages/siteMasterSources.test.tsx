import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { SiteMasterSourceDetails, SiteMasterSources } from '@/components/SiteMasterSource';
import { siteMasterSourceHref, type SiteMasterCellSource } from '@/api/siteMaster';
import { Sites } from './Sites';

/** P1 Master (contract 0.15.35): the source of a Master cell, the drill-down link and the "not tracked" marker, in English and Arabic. */
const SITE = 'a0000000-0000-4000-8000-000000000001';

const cellOf = (code: string, ord: number): HTMLElement => {
  const row = screen.getByTestId(`site-master-grid-row-${code}`);
  const td = row.querySelector(`td[data-ord="${ord}"]`);
  if (!td) throw new Error(`no cell ${ord}`);
  return td as HTMLElement;
};

describe('Site Master grid: source of a cell and not tracked columns', () => {
  it('shows a visible "Not tracked" marker for a column with no source, not a dash', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=dismantle&layout=grid' });
    await screen.findByTestId('site-master-grid-row-S360-001');
    expect(within(cellOf('S360-001', 172)).getByTestId('site-master-grid-not-tracked')).toHaveTextContent('Not tracked');
    // a tracked column without a value keeps the dash
    expect(cellOf('S360-001', 170)).toHaveTextContent('-');
  });

  it('shows the Arabic marker in the Arabic locale', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=dismantle&layout=grid', locale: 'ar' });
    await screen.findByTestId('site-master-grid-row-S360-001');
    expect(within(cellOf('S360-001', 172)).getByTestId('site-master-grid-not-tracked')).toHaveTextContent('غير متتبَّع');
  });

  it('a click on a register cell opens its source with a link to the register record', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=te&layout=grid' });
    await screen.findByTestId('site-master-grid-row-S360-001');
    expect(screen.getByTestId('site-master-source-hint')).toBeTruthy();
    fireEvent.mouseDown(cellOf('S360-001', 78), { button: 0 });
    const panel = await screen.findByTestId('site-master-source-panel');
    expect(panel.getAttribute('data-ord')).toBe('78');
    expect(await within(panel).findByTestId('site-master-source-kind')).toHaveTextContent('Register record');
    expect(within(panel).getByTestId('site-master-source-origin')).toHaveTextContent('Approved register record');
    expect(within(panel).getByTestId('site-master-source-open').getAttribute('href')).toBe('/registers/permits_hse?record=b0000000-0000-4000-8000-000000000078');
    fireEvent.click(within(panel).getByTestId('site-master-source-close'));
    expect(screen.queryByTestId('site-master-source-panel')).toBeNull();
  });

  it('a hidden value shows the kind without a link (Arabic)', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=dismantle&layout=grid', locale: 'ar' });
    await screen.findByTestId('site-master-grid-row-S360-001');
    fireEvent.mouseDown(cellOf('S360-001', 170), { button: 0 });
    const panel = await screen.findByTestId('site-master-source-panel');
    expect(await within(panel).findByTestId('site-master-source-hidden')).toHaveTextContent('مخفي حسب صلاحياتك');
    expect(within(panel).getByTestId('site-master-source-kind')).toHaveTextContent('سجل');
    expect(within(panel).queryByTestId('site-master-source-open')).toBeNull();
  });
});

describe('site page: the Master tab', () => {
  it('lists every column with its value, its source and the link to the task', async () => {
    await signIn('pm');
    renderApp(<SiteMasterSources siteId={SITE} />);
    const table = await screen.findByTestId('site-master-sources');
    expect(within(table).getByTestId('site-master-row-B')).toHaveTextContent('S360-001');
    const gate = within(table).getByTestId('site-master-row-W');
    expect(within(gate).getByTestId('site-master-src-W-kind')).toHaveTextContent('Milestone');
    expect(within(gate).getByTestId('site-master-src-W-open').getAttribute('href')).toBe(`/sites/${SITE}?task=c0000000-0000-4000-8000-000000000023&row=c0000000-0000-4000-8000-000000000023`);
    expect(within(table).getByTestId('site-master-not-tracked-FP')).toHaveTextContent('Not tracked');
  });

  it('renders in Arabic', async () => {
    await signIn('pm');
    renderApp(<SiteMasterSources siteId={SITE} />, { locale: 'ar' });
    const table = await screen.findByTestId('site-master-sources');
    expect(within(table).getByTestId('site-master-not-tracked-FP')).toHaveTextContent('غير متتبَّع');
    expect(within(table).getByTestId('site-master-src-W-origin')).toHaveTextContent('سير العمل');
  });
});

describe('the link of a source', () => {
  const base: SiteMasterCellSource = { ord: 21, letter: 'U', header: 'Baseline', kind: 'baseline', note: null, value: '2026-01-01', hidden: false, origin: 'approved_record' };
  it('opens a record, a task, the feeding record or the site; never for a hidden value, a formula or a not tracked column', () => {
    expect(siteMasterSourceHref(SITE, { ...base, kind: 'register', register_key: 'dismantle', record_id: 'r1' })).toBe('/registers/dismantle?record=r1');
    expect(siteMasterSourceHref(SITE, { ...base, kind: 'register', register_key: 'dismantle', record_id: 'r1', hidden: true })).toBeNull();
    expect(siteMasterSourceHref(SITE, { ...base, kind: 'task', task_id: 't1' })).toBe(`/sites/${SITE}?task=t1&row=t1`);
    expect(siteMasterSourceHref(SITE, { ...base, kind: 'site', fed_by: { register_key: 'rf_design', record_id: 'f1' } })).toBe('/registers/rf_design?record=f1');
    expect(siteMasterSourceHref(SITE, { ...base, kind: 'site' })).toBe(`/sites/${SITE}`);
    expect(siteMasterSourceHref(SITE, { ...base, kind: 'derived' })).toBeNull();
    expect(siteMasterSourceHref(SITE, { ...base, kind: 'not_tracked', value: null, origin: null })).toBeNull();
  });

  it('the details show the baseline version and the rule', async () => {
    await signIn('pm');
    renderApp(<SiteMasterSourceDetails siteId={SITE} cell={{ ...base, baseline_version: 3, field: 'MS1', note: 'Baseline of MS1 Site Release.' }} />);
    const d = screen.getByTestId('site-master-source-details');
    expect(d).toHaveTextContent('Baseline version 3');
    expect(d).toHaveTextContent('Baseline of MS1 Site Release.');
  });
});
