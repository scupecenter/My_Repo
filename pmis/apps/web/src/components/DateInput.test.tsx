import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DateInput, isIsoDate, normaliseDateText } from './DateInput';
import '@/i18n';

function Host({ spy }: { spy: (v: string) => void }) {
  const [v, setV] = useState('2026-10-22');
  return <DateInput data-testid="d" value={v} onChange={(e) => { setV(e.target.value); spy(e.target.value); }} />;
}
describe('DateInput', () => {
  it('normalises Arabic digits and separators, and validates real dates', () => {
    expect(normaliseDateText('٢٠٢٦/١٠/٢٢')).toBe('2026-10-22');
    expect(normaliseDateText('2026.1.2')).toBe('2026-1-2');
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
  });
  it('shows ISO with a YYYY-MM-DD placeholder, never mm/dd/yyyy', () => {
    render(<Host spy={() => {}} />);
    const i = screen.getByTestId('d') as HTMLInputElement;
    expect(i.value).toBe('2026-10-22');
    expect(i.placeholder).toBe('YYYY-MM-DD');
    expect(i.type).toBe('text');
  });
  it('fires onChange only for a complete valid date or an empty value', async () => {
    const spy = vi.fn();
    render(<Host spy={spy} />);
    const i = screen.getByTestId('d') as HTMLInputElement;
    const u = userEvent.setup();
    await u.clear(i);
    expect(spy).toHaveBeenLastCalledWith('');
    spy.mockClear();
    await u.type(i, '2026-1');
    expect(spy).not.toHaveBeenCalled();
    await u.type(i, '1-05');
    expect(spy).toHaveBeenLastCalledWith('2026-11-05');
    fireEvent.change(i, { target: { value: '٢٠٢٧/٠١/٠٢' } });
    expect(spy).toHaveBeenLastCalledWith('2027-01-02');
  });
  it('has a calendar button with an accessible label, and none when picker is off', () => {
    const { rerender } = render(<DateInput data-testid="d" value="" onChange={() => {}} />);
    expect(screen.getByTestId('d-pick')).toHaveAttribute('aria-label');
    rerender(<DateInput data-testid="d" picker={false} value="" onChange={() => {}} />);
    expect(screen.queryByTestId('d-pick')).toBeNull();
  });
});
