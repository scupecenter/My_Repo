import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { copyData } from '@/lib/registerDuplicate';
import { recId } from '@/mocks/registersData';
import { renderApp, signIn } from '@/test/utils';
import type { RegisterDefinition, RegisterRecord } from '@/api/types';
import { RegisterPage } from './Register';

const Routed = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;

describe('Duplicate record', () => {
  it('copyData leaves out read-only fields, files and child lists', () => {
    const def = { fields: [{ code: 'a', type: 'text' }, { code: 'b', type: 'text', read_only: true }, { code: 'c', type: 'file' }, { code: 'd', type: 'child_list' }, { code: 'e', type: 'number' }] } as unknown as RegisterDefinition;
    const rec = { data: { a: 'x', b: 'y', c: 'z', d: [1], e: 5 } } as unknown as RegisterRecord;
    expect(copyData(def, rec)).toEqual({ a: 'x', e: 5 });
  });

  it('the bulk bar opens a new record filled from the one row picked, and the drawer button does the same from a record', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/procurement' });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId(`reg-select-${recId(1)}`));
    await u.click(await screen.findByTestId('register-bulk-duplicate'));
    expect(await screen.findByTestId('reg-copy-banner')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('reg-save')).toBeEnabled());
    // from an open record
    await u.keyboard('{Escape}');
    const discard = screen.queryByRole('button', { name: /discard/i });
    if (discard) await u.click(discard);
    await waitFor(() => expect(screen.queryByTestId('reg-copy-banner')).toBeNull());
    await u.click(await screen.findByTestId(`reg-row-${recId(1)}`));
    await u.click(await screen.findByTestId('reg-duplicate'));
    expect(await screen.findByTestId('reg-copy-banner')).toBeInTheDocument();
  }, 30_000);
});
