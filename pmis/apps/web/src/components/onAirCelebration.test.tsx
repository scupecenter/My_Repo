import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '@/i18n';
import { OnAirCelebration } from './OnAirCelebration';
import { CELEBRATE_KEY, reachedOnAir } from '@/lib/celebrate';

afterEach(() => localStorage.removeItem(CELEBRATE_KEY));

describe('On-Air celebration', () => {
  it('only a change from not On-Air to On-Air counts', () => {
    expect(reachedOnAir(null, true)).toBe(false);
    expect(reachedOnAir(true, true)).toBe(false);
    expect(reachedOnAir(false, false)).toBe(false);
    expect(reachedOnAir(false, true)).toBe(true);
  });
  it('plays when the open site reaches On-Air, not on first load', () => {
    const { rerender } = render(<OnAirCelebration onAir={true} code="S1" />);
    expect(screen.queryByTestId('onair-celebration')).toBeNull();
    rerender(<OnAirCelebration onAir={false} code="S1" />);
    act(() => { rerender(<OnAirCelebration onAir={true} code="S1" />); });
    expect(screen.getByTestId('onair-celebration')).toHaveTextContent('S1');
  });
  it('stays quiet when switched off in Settings', () => {
    localStorage.setItem(CELEBRATE_KEY, 'false');
    const { rerender } = render(<OnAirCelebration onAir={false} code="S1" />);
    rerender(<OnAirCelebration onAir={true} code="S1" />);
    expect(screen.queryByTestId('onair-celebration')).toBeNull();
  });
});
