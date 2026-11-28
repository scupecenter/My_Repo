import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/i18n';
import type { RegisterField } from '@/api/types';
import { FieldValue, relDay } from './FieldValue';

const list = (colour: string | null): RegisterField => ({
  code: 'status', label_en: 'Status', type: 'list',
  options: [{ value: 'open', label_en: 'Open', label_ar: 'مفتوح', ...(colour ? { colour } : {}) }, { value: 'shut', label_en: 'Shut' }],
} as RegisterField);

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('FieldValue', () => {
  it('shows a list value as a chip in its list colour, plain text without one', () => {
    const { rerender } = render(<FieldValue f={list('#0e7490')} v="open" testid="fv" />);
    expect(screen.getByTestId('fv')).toHaveTextContent('Open');
    expect(screen.getByTestId('fv')).toHaveAttribute('data-colour', '#0e7490');
    rerender(<FieldValue f={list(null)} v="open" testid="fv" />);
    expect(screen.getByTestId('fv')).not.toHaveAttribute('data-colour');
    expect(screen.getByTestId('fv')).toHaveTextContent('Open');
  });
  it('V8: colours off draws the plain text, the stored colour untouched', () => {
    render(<FieldValue f={list('#0e7490')} v="open" colors={false} testid="fv" />);
    expect(screen.getByTestId('fv')).toHaveTextContent('Open');
    expect(screen.getByTestId('fv')).not.toHaveAttribute('data-colour');
  });
  it('draws a percentage as a number with one progress bar', () => {
    const f = { code: 'pct', label_en: 'Done', type: 'percentage' } as unknown as RegisterField;
    render(<FieldValue f={f} v={45} testid="fv" />);
    expect(screen.getByTestId('fv')).toHaveTextContent('45%');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
  });
  it('reads a near date relatively with a tone and keeps the absolute date', () => {
    const f = { code: 'due', label_en: 'Due', type: 'date' } as RegisterField;
    const today = new Date();
    const plus3 = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3));
    render(<FieldValue f={f} v={plus3} testid="fv" />);
    expect(screen.getByTestId('fv')).toHaveTextContent('in 3 days');
    expect(screen.getByTestId('fv')).toHaveAttribute('title', plus3);
    expect(screen.getByTestId('fv')).toHaveAttribute('data-rel-days', '3');
    // the relative plus absolute text truncates inside its cell instead of overflowing onto the neighbour (RTL overlap, 2026-11-27)
    expect(screen.getByTestId('fv').className).toContain('truncate');
  });
  it('marks a past date late and leaves far dates absolute', () => {
    const f = { code: 'due', label_en: 'Due', type: 'date' } as RegisterField;
    const today = new Date();
    const minus2 = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2));
    const { rerender } = render(<FieldValue f={f} v={minus2} testid="fv" />);
    expect(screen.getByTestId('fv').className).toContain('text-lateInk');
    rerender(<FieldValue f={f} v="2099-01-01" testid="fv" />);
    expect(screen.getByTestId('fv')).toHaveTextContent('2099-01-01');
    expect(screen.getByTestId('fv')).not.toHaveAttribute('data-rel-days');
  });
  it('relDay counts calendar days from today', () => {
    const now = new Date(2026, 10, 27);
    expect(relDay('2026-11-27', now)).toBe(0);
    expect(relDay('2026-11-30', now)).toBe(3);
    expect(relDay('2026-11-25', now)).toBe(-2);
    expect(relDay('not a date', now)).toBeNull();
  });
});
