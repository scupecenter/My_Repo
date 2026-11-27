import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { emailContent, OWNER_COLUMNS, OWNER_HEADERS, tableText } from '@/lib/dailyPlan';
import type { DailyPlanRow } from '@/api/dailyPlan';
import { resetDailyPlanMock } from '@/mocks/handlers.dailyPlan';
import { renderApp, signIn } from '@/test/utils';

// My Work > Daily Plan (plan W7, contract 0.15.67): the screen, Copy for email (an HTML table on the clipboard) and the export column order.
const DAY = '2026-11-22'; // a Sunday (working day); the next working day is Monday 2026-11-23

let written: { types: string[]; html: string; text: string }[] = [];
class FakeClipboardItem {
  constructor(public items: Record<string, Blob>) {}
  get types() { return Object.keys(this.items); }
  getType(t: string) { return Promise.resolve(this.items[t]!); }
}
/** user-event installs its own clipboard at setup: this one replaces it afterwards and records what the page writes. */
function stubClipboard() {
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: async (items: FakeClipboardItem[]) => {
        for (const it of items) written.push({ types: it.types, html: await it.items['text/html']!.text(), text: await it.items['text/plain']!.text() });
      },
      writeText: vi.fn(),
    },
  });
}
beforeEach(() => {
  resetDailyPlanMock();
  written = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('My Work > Daily Plan', () => {
  it('opens from the side menu under My Work, with the Progress and Tomorrow tabs and the rows filled from system data', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: `/my-work/daily-plan?date=${DAY}` });
    expect(await screen.findByTestId('page-daily-plan')).toBeInTheDocument();
    expect(await screen.findByTestId('nav-daily_plan')).toHaveAttribute('href', '/my-work/daily-plan');
    // the default region scope is "mine" (Tripoli for the demo PM): the Benghazi row is filtered out
    expect(await screen.findByTestId('daily-plan-row-TR101')).toBeInTheDocument();
    expect(screen.queryByTestId('daily-plan-row-BG009')).toBeNull();
    expect(screen.getByTestId('daily-plan-count')).toHaveTextContent('2 sites');
    // the headers follow the owner's order of the Progress table
    const heads = within(screen.getByTestId('daily-plan-table')).getAllByRole('columnheader').map((h) => h.getAttribute('data-testid')).filter(Boolean);
    expect(heads).toEqual(OWNER_COLUMNS.progress.map((c) => `daily-plan-th-${c}`));
    expect(screen.getByTestId('daily-plan-cell-TR101-contractor')).toHaveTextContent('North Build Co (synthetic)');
    // TR102 has planned work and nothing done: below target without a reason
    expect(screen.getByTestId('daily-plan-reason-missing-TR102')).toBeInTheDocument();
    // all regions
    await u.click(screen.getByTestId('filter-chip-remove-x-region'));
    await waitFor(() => expect(screen.queryByTestId('daily-plan-row-BG009')).toBeInTheDocument());

    await u.click(screen.getByTestId('daily-plan-tab-tomorrow'));
    expect(await screen.findByTestId('daily-plan-shown-date')).toHaveTextContent('2026-11-23');
    await waitFor(() => expect(screen.getByTestId('daily-plan-table')).toHaveAttribute('data-tab', 'tomorrow'));
    const heads2 = within(screen.getByTestId('daily-plan-table')).getAllByRole('columnheader').map((h) => h.getAttribute('data-testid')).filter(Boolean);
    expect(heads2).toEqual(OWNER_COLUMNS.tomorrow.map((c) => `daily-plan-th-${c}`));
  });

  it('saves a manual value with the reason, refuses the save without it, and marks the cell changed by hand', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: `/my-work/daily-plan?date=${DAY}` });
    await u.click(await screen.findByTestId('daily-plan-edit-TR102'));
    const dlg = await screen.findByTestId('daily-plan-row-dialog');
    expect(within(dlg).getByTestId('daily-plan-reason-required')).toBeInTheDocument();
    await u.clear(within(dlg).getByTestId('daily-plan-field-tower_owner'));
    await u.type(within(dlg).getByTestId('daily-plan-field-tower_owner'), 'Hand Owner');
    await u.click(within(dlg).getByTestId('daily-plan-row-dialog-submit'));
    expect(await within(dlg).findByTestId('daily-plan-row-dialog-error')).toBeInTheDocument();
    await u.type(within(dlg).getByTestId('daily-plan-field-reason'), 'Rain stopped the crane');
    await u.click(within(dlg).getByTestId('daily-plan-row-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('daily-plan-row-dialog')).toBeNull());
    expect(await screen.findByTestId('daily-plan-manual-TR102-tower_owner')).toBeInTheDocument();
    expect(screen.getByTestId('daily-plan-cell-TR102-tower_owner')).toHaveTextContent('Hand Owner');
    expect(screen.getByTestId('daily-plan-cell-TR102-reason')).toHaveTextContent('Rain stopped the crane');
    expect(screen.queryByTestId('daily-plan-reason-missing-TR102')).toBeNull();
  });

  it('adds a site by hand and removes it', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: `/my-work/daily-plan?date=${DAY}` });
    await u.click(await screen.findByTestId('daily-plan-add'));
    await u.type(await screen.findByTestId('daily-plan-add-code'), 'tr150');
    await u.click(screen.getByTestId('daily-plan-add-dialog-submit'));
    expect(await screen.findByTestId('daily-plan-row-TR150')).toBeInTheDocument();
    await u.click(screen.getByTestId('daily-plan-remove-TR150'));
    await waitFor(() => expect(screen.queryByTestId('daily-plan-row-TR150')).toBeNull());
  });

  it('Copy for email puts both tables on the clipboard as an HTML table with a plain-text fallback and the owner titles', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    stubClipboard();
    renderApp(<App />, { route: `/my-work/daily-plan?date=${DAY}` });
    await screen.findByTestId('daily-plan-row-TR101');
    await u.click(await screen.findByTestId('more-menu')); // P10: Export and Copy for email live in the More menu
    await waitFor(() => expect(screen.getByTestId('daily-plan-copy')).toBeEnabled());
    await u.click(screen.getByTestId('daily-plan-copy'));
    await waitFor(() => expect(written).toHaveLength(1));
    const w = written[0]!;
    expect(w.types.sort()).toEqual(['text/html', 'text/plain']);
    const doc = new DOMParser().parseFromString(w.html, 'text/html');
    const tables = doc.querySelectorAll('table');
    expect(tables).toHaveLength(2);
    expect(w.html).toContain(`Daily Progress ${DAY}`);
    expect(w.html).toContain('Tomorrow Plan 2026-11-23');
    expect([...tables[0]!.querySelectorAll('th')].map((th) => th.textContent)).toEqual(OWNER_COLUMNS.progress.map((c) => OWNER_HEADERS[c]));
    expect([...tables[1]!.querySelectorAll('th')].map((th) => th.textContent)).toEqual(OWNER_COLUMNS.tomorrow.map((c) => OWNER_HEADERS[c]));
    expect(tables[0]!.textContent).toContain('TR101');
    expect(w.text.split('\n')[0]).toBe(`Daily Progress ${DAY}`);
    expect(w.text).toContain('No\tSite ID\tTower Owner');
  });

  it('Export downloads the Excel of the current view (the server keeps the owner column order)', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const calls: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => { calls.push(String(input)); return real(input, init); });
    renderApp(<App />, { route: `/my-work/daily-plan?date=${DAY}` });
    await screen.findByTestId('daily-plan-row-TR101');
    await u.click(await screen.findByTestId('more-menu'));
    await u.click(await screen.findByTestId('daily-plan-export'));
    await waitFor(() => expect(calls.some((c) => c.includes('/daily-plans/export'))).toBe(true));
    const url = new URL(calls.find((c) => c.includes('/daily-plans/export'))!, 'http://x');
    expect(url.searchParams.get('date')).toBe(DAY);
    expect(url.searchParams.getAll('region_id')).toEqual(['1']);
  });
});

describe('the column order of the export and the copy (owner sheet)', () => {
  it('keeps the exact order of the two tables of the owner sheet', () => {
    expect(OWNER_COLUMNS.progress.map((c) => OWNER_HEADERS[c])).toEqual(['No', 'Site ID', 'Tower Owner', 'Owner ID', 'Latitude', 'Longitude', 'Region', 'Site Type', 'SOW',
      'Vendor / Contractor Name', 'AAT SE', 'Planned Work', 'Actual Work', 'Reason (if not reach target)']);
    expect(OWNER_COLUMNS.tomorrow.map((c) => OWNER_HEADERS[c])).toEqual(['No', 'Site ID', 'Tower Owner', 'Owner ID', 'Latitude', 'Longitude', 'Region', 'Site Type', 'SOW',
      'Vendor / Contractor Name', 'AAT SE', 'Access Valid', 'Planned Work', 'Remark']);
  });

  it('escapes the cells and keeps line breaks as <br> in the HTML and "; " in the text', () => {
    const row = { region_id: 1, site_id: 'x', site_code: 'TR<1>', origin: 'auto', values: { site_code: 'TR<1>', planned_work: 'B5\nB6' }, auto: {}, overridden: [], reason: 'A & B',
      remark: null, planned_count: 2, actual_count: 0, below_target: true, reason_missing: false, frozen: false } as unknown as DailyPlanRow;
    const c = emailContent({ title: 'Daily Progress 2026-11-22', tab: 'progress', rows: [row] }, { title: 'Tomorrow Plan 2026-11-23', tab: 'tomorrow', rows: [] });
    expect(c.html).toContain('TR&lt;1&gt;');
    expect(c.html).toContain('B5<br>B6');
    expect(c.html).toContain('A &amp; B');
    expect(tableText({ title: 't', tab: 'progress', rows: [row] }).split('\n')[2]).toContain('B5; B6');
  });
});

describe('Settings > My Work > Daily Plan', () => {
  it('lists the columns of each tab, saves the order, the scope, the lock time and the reminder with a reason', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: '/admin/settings/my-work/daily-plan' });
    expect(await screen.findByTestId('page-daily-plan-settings')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-screens')).toBeInTheDocument();
    expect(screen.getByTestId('dps-toggle-progress-site_code')).toBeDisabled();
    await u.click(screen.getByTestId('dps-toggle-progress-remark'));
    await u.click(screen.getByTestId('dps-up-progress-remark'));
    await u.selectOptions(screen.getByTestId('dps-scope'), 'all');
    await u.selectOptions(screen.getByTestId('dps-hour'), '16');
    await u.click(screen.getByTestId('dps-save'));
    await u.type(await screen.findByTestId('dps-dialog-reason'), 'Team asked for the remark');
    await u.click(screen.getByTestId('dps-dialog-submit'));
    await waitFor(() => expect(screen.queryByTestId('dps-dialog')).toBeNull());
    const list = [...screen.getByTestId('dps-columns-progress').querySelectorAll('li[data-testid^="dps-col-progress-"]')].map((li) => li.getAttribute('data-testid')!.slice('dps-col-progress-'.length));
    expect(list.slice(-2)).toEqual(['remark', 'reason']);
    expect(screen.getByTestId('dps-scope')).toHaveValue('all');
    expect(screen.getByTestId('dps-hour')).toHaveValue('16');
  });

  it('P10: Export, Copy for email and Settings share one More menu; no loose buttons in the toolbar', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<App />, { route: `/my-work/daily-plan?date=${DAY}` });
    await screen.findByTestId('daily-plan-row-TR101');
    expect(screen.queryByTestId('daily-plan-export')).toBeNull();
    expect(screen.queryByTestId('daily-plan-copy')).toBeNull();
    expect(screen.queryByTestId('daily-plan-settings-link')).toBeNull();
    await u.click(screen.getByTestId('more-menu'));
    expect(await screen.findByTestId('daily-plan-export')).toBeInTheDocument();
    expect(screen.getByTestId('daily-plan-copy')).toBeInTheDocument();
    expect(screen.getByTestId('more-screen-settings')).toBeInTheDocument();
    expect(screen.getAllByTestId('screen-settings-link')).toHaveLength(1); // one gear, not a gear plus a header link
  });

  it('the screen links to its settings for a System Admin only', async () => {
    await signIn('engineer');
    renderApp(<App />, { route: `/my-work/daily-plan?date=${DAY}` });
    expect(await screen.findByTestId('page-daily-plan')).toBeInTheDocument();
    expect(screen.queryByTestId('daily-plan-settings-link')).toBeNull();
    expect(screen.queryByTestId('screen-settings-link')).toBeNull();
  });
});
