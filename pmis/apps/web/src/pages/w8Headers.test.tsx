import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, signIn } from '@/test/utils';
import { bareHeader, headerRuns } from '@/components/TableStandard';
import { Sites } from './Sites';

/** W8 item 2: three header levels (section, group, column name only) in the wide table and in the grouped lists of the Site Master menus. */
describe('W8 three-level headers', () => {
  it('adjacent equal headers merge; frozen columns and a new section break the run', () => {
    const sec: Record<string, string | null> = { a: 'RF', b: 'RF', c: 'RF', d: 'PRE', e: 'PRE' };
    const grp: Record<string, string | null> = { a: 'Id', b: 'Id', c: 'Id', d: 'Id', e: null };
    const cols = [{ id: 'a', pinned: true }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
    expect(headerRuns(cols, (id) => sec[id]!).map((r) => [r.label, r.span])).toEqual([['RF', 1], ['RF', 2], ['PRE', 2]]);
    // the group "Id" of d is in another section: it does not merge with b and c
    expect(headerRuns(cols, (id) => grp[id], (id) => sec[id]!).map((r) => [r.label, r.span])).toEqual([['Id', 1], ['Id', 2], ['Id', 1], ['', 1]]);
  });

  it('a header never repeats its group ("Identification / Site Owner ID" reads "Site Owner ID")', () => {
    expect(bareHeader({ header: 'Identification / Site Owner ID', group_mid: 'Identification', group_top: 'RF & DESIGN' })).toBe('Site Owner ID');
    expect(bareHeader({ header: 'RF & DESIGN / Region', group_mid: null, group_top: 'RF & DESIGN' })).toBe('Region');
    expect(bareHeader({ header: 'Site Name', group_mid: 'Identification' })).toBe('Site Name');
  });

  it('wide table: section row, group row (merged), column row with the name only; a column without a group spans rows 2 and 3', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=master&layout=wide' });
    const table = await screen.findByTestId('sites-wide-table');
    const rows = within(table).getAllByRole('row').slice(0, 3);
    expect(rows).toHaveLength(3);
    expect(screen.getByTestId('wide-col-num')).toHaveAttribute('rowspan', '3');
    const groups = screen.getAllByTestId('wide-subgroup');
    const ident = groups.find((g) => g.textContent === 'Identification')!;
    // Site Name and Region share Identification under RF & DESIGN: one merged cell (Site ID is frozen on its own)
    expect(ident).toHaveAttribute('colspan', '2');
    expect(screen.getByTestId('wide-col-180')).toHaveAttribute('rowspan', '2');
    expect(screen.getByTestId('wide-col-180')).toHaveTextContent('Current Milestone');
    expect(screen.getByTestId('wide-col-5')).toHaveTextContent(/^Region$/);
    for (const h of within(rows[2]!).getAllByRole('columnheader')) expect(h.textContent).not.toMatch(/ \/ /);
  });

  it('a grouped list (Site Master sub-menu): the section and group rows sit above the column names, in the list tracks', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw' });
    await screen.findByTestId('site-row-S360-001');
    const sec = screen.getByTestId('list-bands-section');
    const grp = screen.getByTestId('list-bands-group');
    expect(within(sec).getAllByTestId('list-bands-section-cell').map((c) => c.textContent)).toContain('PRE-CW');
    expect(within(grp).getAllByTestId('list-bands-group-cell').map((c) => c.textContent)).toContain('CW Procurement');
    // the tracks are the list's own: as many grid columns as the header row
    expect(sec.style.gridTemplateColumns).toBe(screen.getByTestId('site360-list-head').querySelector('[role="row"]:last-child')!.getAttribute('style')!.match(/grid-template-columns: ([^;]+)/)![1]);
  });
});
