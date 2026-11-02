import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { siteIdOf, taskIdOf } from '@/mocks/sites';
import { dropCol, moveCol, reconcile, resizeCol, toggleCol, visibleCols, EMPTY_PREFS, type ColDef } from '@/lib/tablePrefs';
import { renderApp, signIn } from '@/test/utils';
import { MyWork } from './MyWork';
import { Site } from './Site';
import { Sites } from './Sites';

const SITE = siteIdOf(0), A1 = taskIdOf(0, 0), A2 = taskIdOf(0, 1);
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;
const DEFS: ColDef[] = [{ id: 'code', w: 80, pinned: true }, { id: 'a', w: 100 }, { id: 'b', w: 100 }, { id: 'c', w: 100, off: true }, { id: 'sec', w: 100, forbidden: true }];

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

describe('column prefs (pure)', () => {
  it('keeps the pinned column first, drops forbidden and unknown ids, and appends new columns', () => {
    const p = reconcile({ ...EMPTY_PREFS, order: ['b', 'gone', 'sec', 'a'], hidden: ['sec', 'gone'] }, DEFS);
    expect(p.order).toEqual(['b', 'a', 'code', 'c']);
    expect(p.hidden).toEqual([]);
    expect(visibleCols(p, DEFS).map((c) => c.id)).toEqual(['code', 'b', 'a', 'c']); // pinned first; forbidden never shown
  });
  it('hides, moves, drops and resizes, but never hides or moves the pinned column', () => {
    let p = reconcile(EMPTY_PREFS, DEFS);
    expect(toggleCol(p, DEFS, 'code')).toBe(p);
    p = toggleCol(p, DEFS, 'a');
    expect(visibleCols(p, DEFS).map((c) => c.id)).toEqual(['code', 'b', 'c']);
    p = moveCol(p, DEFS, 'b', 1);
    expect(p.order.filter((x) => x !== 'sec')).toEqual(['code', 'a', 'c', 'b']);
    expect(dropCol(p, DEFS, 'code', 'b')).toBe(p);
    expect(dropCol(p, DEFS, 'b', 'a').order.indexOf('b')).toBeLessThan(dropCol(p, DEFS, 'b', 'a').order.indexOf('a'));
    expect(resizeCol(p, DEFS, 'b', 5).width.b).toBe(60); // minimum
    expect(resizeCol(p, DEFS, 'b', 9999).width.b).toBe(640);
  });
});

describe('Sites list: prefs, chips, selection', () => {
  it('hides and reorders columns, remembers them per user after a reload, and resets', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    const first = renderApp(<Sites />, { route: '/sites' });
    await firstCode();
    expect(screen.getByRole('columnheader', { name: /Scenario/ })).toBeInTheDocument();
    await u.click(screen.getByTestId('cols-menu'));
    expect(screen.getByTestId('col-toggle-code')).toBeDisabled(); // identity column is pinned
    await u.click(screen.getByTestId('col-toggle-scenario'));
    await u.click(screen.getByTestId('col-later-name'));
    await u.click(screen.getByTestId('density-compact'));
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: /Scenario/ })).toBeNull());
    expect(screen.getByTestId('sites-scroll').parentElement).toHaveAttribute('data-density', 'compact');
    first.unmount();

    renderApp(<Sites />, { route: '/sites' }); // a fresh mount reads the stored prefs
    await screen.findByTestId('sites-list');
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: /Scenario/ })).toBeNull());
    const heads = screen.getAllByRole('columnheader').map((h) => h.getAttribute('data-col')).filter(Boolean);
    expect(heads.indexOf('region')).toBeLessThan(heads.indexOf('name'));
    await u.click(screen.getByTestId('cols-menu'));
    await u.click(screen.getByTestId('cols-reset'));
    expect(await screen.findByRole('columnheader', { name: /Scenario/ })).toBeInTheDocument();
  });

  it('shows active-filter chips from the URL, removes one, clears all, and tells no data from no results', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites?region_id=1&q=zzzz' });
    expect(await screen.findByTestId('sites-empty')).toHaveAttribute('data-testid', 'sites-empty');
    expect(screen.getByTestId('sites-empty-clear')).toBeInTheDocument(); // "no results" has a Clear button
    expect(screen.getByTestId('toolbar-active-filters')).toHaveTextContent('2');
    expect(screen.getByTestId('chip-q')).toHaveTextContent('zzzz');
    expect(screen.getByTestId('chip-region_id')).toBeInTheDocument();
    await u.click(screen.getByTestId('chip-remove-q'));
    await waitFor(() => expect(screen.queryByTestId('chip-q')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('sites-empty')).toBeNull());
    await u.click(screen.getByTestId('chips-clear'));
    await waitFor(() => expect(screen.queryByTestId('active-chips')).toBeNull());
    expect(screen.getByTestId('sites-filter-region')).toHaveValue('');
  });

  it('applies the late quick filter through the API bucket filter', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites' });
    await waitFor(() => expect(screen.getByTestId('sites-count')).toHaveTextContent('150'));
    await userEvent.click(screen.getByTestId('sites-quick-late'));
    expect(screen.getByTestId('sites-quick-late')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chip-bucket')).toBeInTheDocument();
    await waitFor(() => expect(Number(screen.getByTestId('sites-count').textContent?.match(/\d+/)?.[0])).toBeLessThan(150));
  });

  it('selects rows, shows a bulk bar that separates loaded rows from all matching, and clears', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<Sites />, { route: '/sites' });
    const code = await firstCode();
    await screen.findByTestId(`site-row-${code}`);
    expect(screen.queryByTestId('sites-bulk')).toBeNull();
    await u.click(screen.getByTestId(`site-select-${code}`));
    expect(screen.getByTestId('sites-bulk-count')).toHaveTextContent('1 selected');
    expect(screen.getByTestId('sites-bulk-scope')).toHaveTextContent(/rows loaded \(150 match/);
    expect(screen.getByTestId('sites-bulk-open')).toBeInTheDocument();
    await u.click(screen.getByTestId('sites-select-all'));
    expect(Number(screen.getByTestId('sites-bulk-count').textContent?.match(/\d+/)?.[0])).toBeGreaterThan(1);
    expect(screen.queryByTestId('sites-bulk-open')).toBeNull(); // opening is for a single row
    await u.click(screen.getByTestId('sites-bulk-clear'));
    expect(screen.queryByTestId('sites-bulk')).toBeNull();
  });
});

async function firstCode() {
  const rows = await screen.findAllByTestId(/^site-row-/);
  return rows[0].getAttribute('data-testid')!.replace('site-row-', '');
}

describe('Task drawer: next/previous with the unsaved guard, and the grid', () => {
  it('walks through the grid list and asks before leaving unsaved input', async () => {
    await signIn('reviewer');
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    await u.click(await screen.findByTestId(`grid-open-${A1}`));
    const drawer = await screen.findByTestId('task-drawer');
    await within(drawer).findByTestId('task-drawer-body');
    expect(screen.getByTestId('drawer-prev')).toBeDisabled(); // first of the list
    expect(screen.getByTestId('drawer-position')).toHaveTextContent(/^1 of \d+$/);

    fireEvent.change(await screen.findByTestId('drawer-plan-date'), { target: { value: '2031-01-02' } }); // unsaved edit
    await u.click(screen.getByTestId('drawer-next'));
    expect(await screen.findByTestId('drawer-discard')).toBeInTheDocument();
    await u.click(screen.getByTestId('drawer-discard-keep'));
    expect(screen.queryByTestId('drawer-discard')).toBeNull();
    expect(screen.getByTestId('drawer-position')).toHaveTextContent(/^1 of/); // still on the first task

    await u.click(screen.getByTestId('drawer-next'));
    await u.click(await screen.findByTestId('drawer-discard-go'));
    await waitFor(() => expect(screen.getByTestId('drawer-position')).toHaveTextContent(/^2 of/));
    await waitFor(() => expect(screen.getByTestId('task-drawer-body')).toBeInTheDocument());
    expect(screen.getByTestId('drawer-prev')).toBeEnabled();
    // a clean drawer moves without asking
    await u.click(screen.getByTestId('drawer-prev'));
    expect(screen.queryByTestId('drawer-discard')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('drawer-position')).toHaveTextContent(/^1 of/));
  });

  it('expands to full screen (remembered), resizes by keyboard, shows tabs, and returns focus to the row on Esc', async () => {
    await signIn('reviewer');
    const u = userEvent.setup();
    const first = renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    const opener = await screen.findByTestId(`grid-open-${A1}`);
    opener.focus();
    await u.click(opener);
    const drawer = await screen.findByTestId('task-drawer');
    expect(screen.getByTestId('drawer-tab-documents')).toBeInTheDocument();
    await u.click(screen.getByTestId('drawer-tab-comments'));
    expect(screen.getByTestId('comment-input')).toBeVisible();
    const w0 = Number(screen.getByTestId('drawer-resize').getAttribute('aria-valuenow'));
    fireEvent.keyDown(screen.getByTestId('drawer-resize'), { key: 'ArrowLeft' });
    expect(Number(screen.getByTestId('drawer-resize').getAttribute('aria-valuenow'))).toBeGreaterThan(w0);
    await u.click(screen.getByTestId('drawer-expand'));
    expect(drawer).toHaveAttribute('data-full', 'true');
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('task-drawer')).toBeNull());
    expect(document.activeElement).toBe(opener);
    first.unmount();
    renderApp(<SiteAt />, { route: `/sites/${SITE}?task=${A1}` });
    expect(await screen.findByTestId('task-drawer')).toHaveAttribute('data-full', 'true'); // mode remembered
  });

  it('selects tasks in the grid, shows the bulk bar, and filters to late tasks with a removable chip', async () => {
    await signIn('reviewer');
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    await u.click(await screen.findByTestId(`grid-select-${A1}`));
    await u.click(screen.getByTestId(`grid-select-${A2}`));
    expect(screen.getByTestId('grid-bulk-count')).toHaveTextContent('2 selected');
    expect(screen.queryByTestId('grid-bulk-open')).toBeNull();
    await u.click(screen.getByTestId('grid-bulk-clear'));
    expect(screen.queryByTestId('grid-bulk')).toBeNull();
    await u.click(screen.getByTestId('tf-late'));
    expect(screen.getByTestId('chip-tf-late')).toHaveTextContent(/loaded rows/);
    await u.click(screen.getByTestId('chip-remove-tf-late'));
    expect(screen.queryByTestId('active-chips')).toBeNull();
    expect(screen.getByTestId(`grid-row-${A1}`)).toBeInTheDocument();
  });

  it('hides the date columns from the grid and the keyboard model follows', async () => {
    await signIn('reviewer');
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    await screen.findByTestId(`grid-cell-${A1}-plan`);
    await u.click(screen.getByTestId('cols-menu'));
    await u.click(screen.getByTestId('col-toggle-plan'));
    await waitFor(() => expect(screen.queryByTestId(`grid-cell-${A1}-plan`)).toBeNull());
    expect(screen.getByTestId(`grid-cell-${A1}-actual`)).toBeInTheDocument();
  });
});

describe('My Work', () => {
  it('opens the task drawer straight from a card', async () => {
    await signIn('reviewer');
    renderApp(<MyWork />, { route: '/my-work' });
    const card = (await screen.findAllByTestId(/^task-card-open-/))[0];
    await userEvent.click(card);
    expect(await screen.findByTestId('task-drawer')).toBeInTheDocument();
    await screen.findByTestId('task-drawer-body');
  });
});
