import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { SearchBox, ShownFooter, TableCount } from '@/components/TableStandard';
import '@/i18n';
import i18n from '@/i18n';
import { Sites } from './Sites';

/** W8 (plan 2026-11-23-next-ui-cleanup): the counts (item 6), the row numbers (item 1) and the pasted-list search (item 5). */
describe('W8 counts', () => {
  it('unfiltered, filtered (bold, Clear filters), selected; Arabic text', async () => {
    await i18n.changeLanguage('en');
    const { rerender } = render(<TableCount noun="sites" total={469} filtered={469} active={false} />);
    expect(screen.getByTestId('table-count')).toHaveTextContent(/^469 sites$/);
    expect(screen.queryByTestId('table-count-clear')).toBeNull();
    let cleared = 0;
    rerender(<TableCount noun="sites" total={469} filtered={120} active selected={3} onClear={() => { cleared += 1; }} />);
    expect(screen.getByTestId('table-count-text')).toHaveTextContent('120 of 469 sites');
    expect(screen.getByTestId('table-count-filtered').tagName).toBe('B');
    expect(screen.getByTestId('table-count-filtered')).toHaveTextContent('120');
    expect(screen.getByTestId('table-count-selected')).toHaveTextContent('· 3 selected');
    fireEvent.click(screen.getByTestId('table-count-clear'));
    expect(cleared).toBe(1);
    rerender(<TableCount noun="tasks" total={45} filtered={12} active />);
    expect(screen.getByTestId('table-count-text')).toHaveTextContent('12 of 45 tasks');
    await i18n.changeLanguage('ar');
    rerender(<TableCount noun="sites" total={469} filtered={120} active />);
    expect(screen.getByTestId('table-count-text')).toHaveTextContent('120 من 469 موقعًا');
    await i18n.changeLanguage('en');
  });

  it('partly loaded: "Showing 50 of 120", gone when everything is loaded; Arabic', async () => {
    await i18n.changeLanguage('en');
    const { rerender } = render(<ShownFooter shown={50} filtered={120} />);
    expect(screen.getByTestId('table-shown')).toHaveTextContent('Showing 50 of 120');
    rerender(<ShownFooter shown={120} filtered={120} />);
    expect(screen.queryByTestId('table-shown')).toBeNull();
    await i18n.changeLanguage('ar');
    rerender(<ShownFooter shown={50} filtered={120} />);
    expect(screen.getByTestId('table-shown')).toHaveTextContent('يُعرض 50 من 120');
    await i18n.changeLanguage('en');
  });

  it('Site Master: the count comes from the server (total and filtered), not from the loaded rows', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?layout=list' });
    await waitFor(() => expect(screen.getByTestId('sites-count-text')).toHaveTextContent(/^150 sites$/));
    // 100 rows are loaded per page, the count still says 150
    expect(screen.getByTestId('sites-count')).toHaveAttribute('data-total', '150');
    renderApp(<Sites />, { route: '/sites?layout=list&region_id=1' });
    await waitFor(() => expect(screen.getAllByTestId('sites-count-text').at(-1)!).toHaveTextContent(/^\d+ of 150 sites$/));
    expect(screen.getAllByTestId('sites-count-clear').length).toBeGreaterThan(0);
  });
});

describe('W8 row numbers', () => {
  it('# is the first frozen column, 1..n in the current sort and filter', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?layout=list' });
    const first = await screen.findByTestId('site-row-TR101');
    expect(within(first).getByTestId('row-no')).toHaveTextContent('1');
    const heads = screen.getAllByRole('columnheader');
    expect(heads[1]).toHaveTextContent('#');
    const nums = screen.getAllByTestId('row-no').slice(0, 5).map((e) => Number(e.textContent));
    expect(nums).toEqual([1, 2, 3, 4, 5]);
  });

  it('a menu list numbers its rows from the server (row_no), so the numbers continue across "Load more" pages', async () => {
    await signIn('pm');
    renderApp(<Sites />, { route: '/sites?section=cw' });
    const row = await screen.findByTestId('site-row-S360-002');
    expect(within(row).getByTestId('row-no')).toHaveTextContent('2');
  });
});

describe('W8 pasted-list search', () => {
  it('a paste from Excel keeps the codes apart (new lines and tabs become spaces)', () => {
    function Box() { const [v, setV] = useState(''); return <><SearchBox testid="box" value={v} onChange={setV} /><output data-testid="out">{v}</output></>; }
    render(<Box />);
    fireEvent.paste(screen.getByTestId('box'), { clipboardData: { getData: () => 'BG009\r\nBG010\tBG012\n' } });
    expect(screen.getByTestId('out').textContent).toBe('BG009 BG010 BG012');
  });

  it('Site Master: spaces, new lines, mixed case; one row per site, the chip and the not-found list; the server gets the text', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/sites') && u.searchParams.get('q')) seen.push(u.searchParams.get('q')!); });
    renderApp(<Sites />, { route: `/sites?layout=list&q=${encodeURIComponent('tr101 MI102\nZZ999')}` });
    expect(await screen.findByTestId('site-row-TR101')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId('sites-list')).getAllByRole('listitem')).toHaveLength(2));
    expect(screen.getByTestId('site-row-MI102')).toBeInTheDocument();
    expect(screen.getByTestId('pasted-chip-text')).toHaveTextContent('Sites: 3 pasted, 2 found');
    expect(screen.getByTestId('sites-count-text')).toHaveTextContent('2 of 150 sites');
    await userEvent.click(screen.getByTestId('pasted-chip-missing'));
    expect(await screen.findByTestId('pasted-chip-list')).toHaveTextContent('ZZ999');
    expect(seen.some((x) => x.includes('MI102'))).toBe(true);
  });

  it('a single token keeps the contains search, and a menu list sends the search to the rows endpoint', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { const u = new URL(request.url); if (u.pathname.includes('/site360/') && u.searchParams.get('q')) seen.push(u.searchParams.get('q')!); });
    renderApp(<Sites />, { route: `/sites?section=cw&q=${encodeURIComponent('s360-001 S360-003 nope')}` });
    expect(await screen.findByTestId('site-row-S360-001')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('site-row-S360-002')).toBeNull());
    expect(screen.getByTestId('site-row-S360-003')).toBeInTheDocument();
    expect(screen.getByTestId('pasted-chip-text')).toHaveTextContent('Sites: 3 pasted, 2 found');
    expect(seen.length).toBeGreaterThan(0);
  });
});
