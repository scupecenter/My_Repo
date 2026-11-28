import '@/i18n';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { daysUntil, dueTone, relativeDue } from '@/lib/relativeDue';
import { setExtra } from '@/lib/uiExtras';
import { RelDue } from './RelDue';

/** Item 4: relative due dates with colours. */
const today = new Date(2026, 10, 28, 23, 30);
const ymd = (d: number) => { const x = new Date(2026, 10, 28 + d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
afterEach(() => { act(() => setExtra('relative_due', true)); });

describe('relative due dates', () => {
  it('counts calendar days, even late in the evening', () => {
    expect(daysUntil('2026-11-28', today)).toBe(0);
    expect(daysUntil('2026-11-29', today)).toBe(1);
    expect(daysUntil('2026-11-25', today)).toBe(-3);
    expect(daysUntil('soon', today)).toBeNull();
  });
  it('colours: overdue red, today to 2 days amber, a week blue, later quiet', () => {
    expect([-1, 0, 2, 3, 7, 8].map((d) => dueTone(d))).toEqual(['late', 'soon', 'soon', 'near', 'near', 'far']);
  });
  it('says it in the language', () => {
    expect(relativeDue(0, 'en')).toBe('today');
    expect(relativeDue(1, 'en')).toBe('tomorrow');
    expect(relativeDue(-2, 'en')).toBe('2 days ago');
    expect(relativeDue(14, 'en')).toBe('in 14 days');
    expect(relativeDue(45, 'en')).toBe('in 6 weeks');
    expect(relativeDue(200, 'en')).toBe('in 7 months');
    expect(relativeDue(3, 'ar')).toMatch(/3|٣/);
  });
  it('shows the chip with its tone, hides for a finished task, a bad date and when switched off', () => {
    const { rerender } = render(<RelDue date={ymd(-2)} />);
    expect(screen.getByTestId('rel-due')).toHaveAttribute('data-tone', 'late');
    expect(screen.getByTestId('rel-due')).toHaveTextContent('2 days ago');
    rerender(<RelDue date={ymd(1)} />);
    expect(screen.getByTestId('rel-due')).toHaveAttribute('data-tone', 'soon');
    rerender(<RelDue date={ymd(1)} done />);
    expect(screen.queryByTestId('rel-due')).toBeNull();
    rerender(<RelDue date="nope" />);
    expect(screen.queryByTestId('rel-due')).toBeNull();
    rerender(<RelDue date={ymd(1)} />);
    act(() => setExtra('relative_due', false));
    expect(screen.queryByTestId('rel-due')).toBeNull();
  });
});
