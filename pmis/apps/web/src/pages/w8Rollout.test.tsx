import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/server';
import { renderApp, signIn } from '@/test/utils';
import { toCsv } from '@/components/TableStandard';
import { Approvals } from './Approvals';
import { MyWork } from './MyWork';
import { RegisterPage } from './Register';

/** W8 rollout: the registers, My Work and Approvals carry the same counts, search and row numbers as Site Master. */
const Reg = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;

describe('W8 rollout', () => {
  it('a register: "x of y records" from the server, the pasted list goes to the server, # first', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/records') && u.searchParams.get('q')) seen.push(u.searchParams.get('q')!); });
    renderApp(<Reg />, { route: '/registers/procurement' });
    await waitFor(() => expect(screen.getByTestId('register-count-text')).toHaveTextContent(/^[1-9]\d* records$/));
    const total = Number(screen.getByTestId('register-count').getAttribute('data-total'));
    const first = (await screen.findAllByTestId(/^reg-row-/))[0]!;
    expect(within(first).getByTestId('row-no')).toHaveTextContent('1');
    const u = userEvent.setup();
    await u.type(screen.getByTestId('register-search'), 'TR101 ZZ999');
    await waitFor(() => expect(seen.some((q) => q.includes('ZZ999'))).toBe(true));
    await waitFor(() => expect(screen.getByTestId('register-count-text')).toHaveTextContent(new RegExp(`of ${total} records`)));
    expect(screen.getByTestId('pasted-chip-text')).toHaveTextContent(/Sites: 2 pasted, [0-2] found/);
  });

  it('My Work: the count of the buckets, the search on the server, # across the buckets', async () => {
    await signIn('pm');
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { const u = new URL(request.url); if (u.pathname.endsWith('/me/tasks') && u.searchParams.get('q')) seen.push(u.searchParams.get('q')!); });
    renderApp(<MyWork />, { route: '/my-work' });
    await waitFor(() => expect(screen.getByTestId('my-work-count-do_now')).toHaveTextContent('7'));
    expect(screen.getByTestId('my-work-count-text')).toHaveTextContent(/^\d+ tasks$/);
    const nums = screen.getAllByTestId('row-no').map((e) => Number(e.textContent));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    const u = userEvent.setup();
    await u.type(screen.getByTestId('my-work-search'), 'zzzz');
    await waitFor(() => expect(seen).toContain('zzzz'));
    await waitFor(() => expect(screen.getByTestId('my-work-count-text')).toHaveTextContent(/^0 of \d+ tasks/));
  });

  it('Approvals: the count and # in the inbox; Arabic count', async () => {
    await signIn('pm');
    renderApp(<Approvals />, { route: '/approvals', locale: 'ar' });
    await waitFor(() => expect(screen.getByTestId('approvals-count-text')).toHaveTextContent(/^\d+ مهمة$/));
    expect((await screen.findAllByTestId('row-no'))[0]).toHaveTextContent('1');
  });

  it('the browser export writes a CSV that Excel reads, and neutralises formulas', () => {
    expect(toCsv(['#', 'Site'], [[1, 'TR101'], [2, '=cmd'], [3, 'a,b']])).toBe("#,Site\r\n1,TR101\r\n2,'=cmd\r\n3,\"a,b\"");
  });
});
