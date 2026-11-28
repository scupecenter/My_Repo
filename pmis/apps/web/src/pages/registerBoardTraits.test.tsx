import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { recId } from '@/mocks/registersData';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

const App = () => <Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>;
const T = 20_000;
const ENTRY = recId(3);
const APPROVED = recId(1);
const dt = () => { const m = new Map<string, string>(); return { setData: (k: string, v: string) => m.set(k, v), getData: (k: string) => m.get(k) ?? '', effectAllowed: '', dropEffect: '' }; };

async function openBoard(u: ReturnType<typeof userEvent.setup>) {
  await signIn('pm');
  renderApp(<App />, { route: '/registers/procurement' });
  await screen.findByTestId('register-list-card');
  await u.click(screen.getByTestId('register-view'));
  await u.click(await screen.findByTestId('register-layout-board'));
  await screen.findByTestId('register-board');
}

describe('Register board and list traits', () => {
  it('a card dropped on a column it may not enter shows the reason', async () => {
    const u = userEvent.setup();
    await openBoard(u);
    const card = await screen.findByTestId(`board-record-${APPROVED}`);
    const cols = screen.getAllByTestId(/^board-col-[^c]/).map((e) => e.getAttribute('data-testid')!.replace('board-col-', ''));
    const from = card.closest('[data-testid^="board-cell-"]')!.getAttribute('data-testid')!.split('-')[2];
    const to = cols.find((c) => c !== from)!;
    const data = dt();
    fireEvent.dragStart(card, { dataTransfer: data });
    const cell = screen.getAllByTestId(new RegExp(`^board-cell-${to}-`))[0];
    fireEvent.dragOver(cell, { dataTransfer: data });
    expect(cell).toHaveAttribute('data-drop');
    fireEvent.drop(cell, { dataTransfer: data });
    expect(await screen.findByText(/cannot edit|locked|approval state/i)).toBeInTheDocument();
  }, T);

  it('a card dropped on another status column is saved and can be undone', async () => {
    const u = userEvent.setup();
    await openBoard(u);
    const card = await screen.findByTestId(`board-record-${ENTRY}`);
    const from = card.closest('[data-testid^="board-cell-"]')!.getAttribute('data-testid')!.split('-')[2];
    const to = screen.getAllByTestId(/^board-col-[^c]/).map((e) => e.getAttribute('data-testid')!.replace('board-col-', '')).find((c) => c !== from && c !== '')!;
    const data = dt();
    fireEvent.dragStart(card, { dataTransfer: data });
    const cell = screen.getAllByTestId(new RegExp(`^board-cell-${to}-`))[0];
    fireEvent.dragOver(cell, { dataTransfer: data });
    expect(cell).toHaveAttribute('data-drop', 'ok');
    fireEvent.drop(cell, { dataTransfer: data });
    expect(await screen.findByText('Status changed.')).toBeInTheDocument();
  }, T);

  it('Space on a card opens the quick preview, Escape closes it', async () => {
    const u = userEvent.setup();
    await openBoard(u);
    const card = await screen.findByTestId(`board-record-${ENTRY}`);
    card.focus();
    await u.keyboard(' ');
    const dlg = await screen.findByTestId('register-quick-preview');
    expect(within(dlg).getByTestId('register-quick-preview-open')).toBeInTheDocument();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('register-quick-preview')).toBeNull());
  }, T);

  it('the New button is split: blank record, or import (off with a reason when there is no template)', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<App />, { route: '/registers/procurement' });
    await u.click(await screen.findByTestId('register-new-more'));
    expect(await screen.findByTestId('register-new-blank')).toBeInTheDocument();
    expect(screen.getByTestId('register-new-import')).toBeInTheDocument();
  }, T);

  it('the what is new note shows once and stays dismissed', async () => {
    const u = userEvent.setup();
    localStorage.clear();
    await signIn('pm');
    renderApp(<App />, { route: '/registers/procurement' });
    await u.click(await screen.findByTestId('whatsnew-register-board-preview-2026-11-dismiss'));
    expect(screen.queryByTestId('whatsnew-register-board-preview-2026-11')).toBeNull();
    expect(localStorage.getItem('pmis.whatsnew.register-board-preview-2026-11')).toBe('true');
  }, T);
});
