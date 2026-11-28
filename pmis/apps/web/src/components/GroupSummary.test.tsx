import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { GroupSummary } from './GroupSummary';

const segs = [
  { key: 'red', label: 'Late', count: 3, tone: 'bg-lateInk' },
  { key: 'green', label: 'Within target', count: 1, tone: 'bg-doneInk' },
  { key: 'amber', label: 'Near', count: 0, tone: 'bg-waitInk' },
];

describe('GroupSummary (Item 9)', () => {
  it('draws only the segments with tasks, widths by share, a text alternative and a pressed state', () => {
    const onPick = vi.fn();
    render(<GroupSummary testid="g" group="Do now" segments={segs} active="red" onPick={onPick} show />);
    expect(screen.getByTestId('g').getAttribute('aria-label')).toContain('4');
    expect(screen.getByTestId('g-seg-red').style.width).toBe('75%');
    expect(screen.queryByTestId('g-seg-amber')).toBeNull();
    expect(screen.getByTestId('g-seg-red').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('g-text').querySelectorAll('li')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('g-seg-green'));
    expect(onPick).toHaveBeenLastCalledWith('green');
    fireEvent.click(screen.getByTestId('g-seg-red'));
    expect(onPick).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByTestId('g-clear'));
    expect(onPick).toHaveBeenLastCalledWith(null);
  });
  it('draws nothing when the option is off or the group is empty', () => {
    const { container, rerender } = render(<GroupSummary testid="g" group="x" segments={segs} active={null} onPick={() => undefined} show={false} />);
    expect(container.innerHTML).toBe('');
    rerender(<GroupSummary testid="g" group="x" segments={[{ key: 'red', label: 'L', count: 0, tone: '' }]} active={null} onPick={() => undefined} show />);
    expect(container.innerHTML).toBe('');
  });
});
