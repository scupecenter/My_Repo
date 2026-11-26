import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InlineCell } from './InlineCell';

describe('InlineCell', () => {
  it('saves a changed number on Enter and leaves an unchanged one alone', async () => {
    const u = userEvent.setup();
    const save = vi.fn().mockResolvedValue(undefined);
    render(<InlineCell kind="number" min={0} max={100} value={5} label="Min" testid="c" onCommit={save} />);
    await u.click(screen.getByTestId('c'));
    await u.keyboard('{Enter}');
    expect(save).not.toHaveBeenCalled();
    await u.click(screen.getByTestId('c'));
    await u.clear(screen.getByTestId('c-input'));
    await u.type(screen.getByTestId('c-input'), '12{Enter}');
    expect(save).toHaveBeenCalledWith('12');
  });
  it('cancels on Escape, rejects an out of range number, and shows a failed save', async () => {
    const u = userEvent.setup();
    const save = vi.fn().mockRejectedValue(new Error('nope'));
    render(<InlineCell kind="number" min={0} max={100} value={5} label="Min" testid="c" onCommit={save} />);
    await u.click(screen.getByTestId('c'));
    await u.clear(screen.getByTestId('c-input'));
    await u.type(screen.getByTestId('c-input'), '500{Enter}');
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByTestId('c-err')).toBeInTheDocument();
    await u.clear(screen.getByTestId('c-input'));
    await u.type(screen.getByTestId('c-input'), '7{Enter}');
    expect(await screen.findByText('nope')).toBeInTheDocument();
    await u.keyboard('{Escape}');
    expect(screen.queryByTestId('c-input')).toBeNull();
  });
  it('is plain text when disabled', () => {
    render(<InlineCell value={3} label="Min" testid="c" disabled onCommit={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
