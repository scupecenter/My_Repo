import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { ToastProvider, useToast } from './Toast';
import { ResetResultDialog } from './ResetResultDialog';

function Fire({ kind, text }: { kind?: 'ok' | 'err'; text: string }) {
  const toast = useToast();
  return <button onClick={() => toast(text, kind)}>fire</button>;
}

describe('standard toast', () => {
  afterEach(() => vi.useRealTimers());
  it('ok: green check, text, gone after 4.5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ToastProvider><Fire text="Saved" /></ToastProvider>);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByText('fire'));
    expect(screen.getByTestId('toast-check')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(4400); });
    expect(screen.getByTestId('toast')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId('toast')).toBeNull();
  });
  it('empty text falls back to the word Done', async () => {
    render(<ToastProvider><Fire text="" /></ToastProvider>);
    await userEvent.click(screen.getByText('fire'));
    expect(screen.getByTestId('toast')).toHaveTextContent('Done');
  });
  it('error: persists until closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ToastProvider><Fire kind="err" text="Boom" /></ToastProvider>);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByText('fire'));
    act(() => { vi.advanceTimersByTime(60000); });
    expect(screen.getByText('Boom')).toBeInTheDocument();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByTestId('toast-close'));
    expect(screen.queryByText('Boom')).toBeNull();
  });
});

describe('ResetResultDialog', () => {
  it('shows the summary, no timer, closes only by the button', async () => {
    const onClose = vi.fn();
    render(<ResetResultDialog open onClose={onClose} summary={{ rows: 12, sessions: 2, parts: [{ code: 'a', label: 'Tasks', rows: 12 }], files: { moved: 3, total: 3, pending: 0 } }} />);
    expect(screen.getByTestId('dr-done-check')).toBeInTheDocument();
    expect(screen.getByTestId('dr-done-total')).toHaveTextContent('12');
    expect(screen.getByTestId('dr-done-part-a')).toHaveTextContent('Tasks');
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('dr-done-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
