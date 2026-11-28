import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateNotePanel } from '@/components/PrivateNotePanel';
import { setExtra } from '@/lib/uiExtras';

/** Item 7: a private note under a drawer, switchable on this device. */
const store: { body: string } = { body: '' };
vi.mock('@/api/client', async (orig) => {
  const m = await orig<typeof import('@/api/client')>();
  const note = () => ({ entity_type: 'task', entity_id: 'x', body: store.body, updated_at: store.body ? '2026-11-28T10:00:00Z' : null });
  return { ...m, api: { ...m.api, get: vi.fn(async () => note()), put: vi.fn(async (_p: string, o: { body: { body: string } }) => { store.body = o.body.body; return note(); }) } };
});
const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PrivateNotePanel type="task" id="x" /></QueryClientProvider>);
beforeEach(() => { localStorage.clear(); store.body = ''; });
afterEach(() => { act(() => setExtra('private_notes', true)); });

describe('private note panel', () => {
  it('opens, saves the text and shows that the record has a note', async () => {
    const u = userEvent.setup();
    wrap();
    expect(screen.queryByTestId('private-note-text')).toBeNull();
    await u.click(screen.getByTestId('private-note-toggle'));
    const box = screen.getByTestId('private-note-text');
    expect((screen.getByTestId('private-note-save') as HTMLButtonElement).disabled).toBe(true);
    await u.type(box, 'call Sunday');
    await u.click(screen.getByTestId('private-note-save'));
    await waitFor(() => expect(store.body).toBe('call Sunday'));
    await waitFor(() => expect(screen.getByTestId('private-note-has')).toBeInTheDocument());
  });

  it('is gone when the person switches it off', () => {
    wrap();
    expect(screen.getByTestId('private-note')).toBeInTheDocument();
    act(() => setExtra('private_notes', false));
    expect(screen.queryByTestId('private-note')).toBeNull();
  });
});
