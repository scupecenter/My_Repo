import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/i18n';
import type { RegisterRecord } from '@/api/types';
import { RegisterGrid } from './RegisterGrid';

const rec = (id: string, docs?: RegisterRecord['docs']) => ({ id, state: 'draft', docs }) as unknown as RegisterRecord;

describe('RegisterGrid evidence dot', () => {
  it('draws a dot only for the records that need documents, beside the row number', () => {
    render(<RegisterGrid columns={[{ id: 'a', label: 'A' }]} rows={[rec('r1', { state: 'red', need: 2, approved: 0, pending: 0, missing: 2, rejected: 0, expired: 0 }), rec('r2')]} cell={() => 'x'} onOpen={() => {}} />);
    expect(screen.getByTestId('register-grid-dot-r1')).toHaveAttribute('data-state', 'red');
    expect(screen.queryByTestId('register-grid-dot-r2')).toBeNull();
  });
});
