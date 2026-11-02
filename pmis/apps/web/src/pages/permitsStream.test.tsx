import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import i18n from '@/i18n';
import type { Matrix } from '@/api/types';
import { renderApp, signIn } from '@/test/utils';
import { MatrixPage } from './Matrix';

/**
 * Migration 0050 / contract 0.11.4 (Q90): Permits & HSE has a Matrix row per stream. `permits_hse` covers CW (L1 CW engineers, L2 CW Team Lead) and
 * `permits_hse_te` the TE stream (L1 TE engineers, L2 TE Team Lead). Every row has two levels only: L1 = cell 1, L2 = cell 3.
 */
describe('the Matrix row of the TE permits', () => {
  it('lists the TE stream row right after Permits & HSE, with its own L1 and L2', async () => {
    await signIn('pm');
    const m = await api.get<Matrix>('/matrix');
    const codes = m.stages.map((r) => r.code);
    expect(codes.indexOf('permits_hse_te')).toBe(codes.indexOf('permits_hse') + 1);
    const row = m.stages.find((r) => r.code === 'permits_hse_te')!;
    expect(row.approval_levels).toBe(2);
    expect(row.name_en).toBe('Permits & HSE - TE stream');
    expect(row.name_ar).toBe('التصاريح والسلامة - مسار TE');
    expect(row.cells.find((c) => c.level === 1)!.assignees.map((a) => a.employee_id)).toEqual(['1306']);
    expect(row.cells.find((c) => c.level === 3)!.assignees.map((a) => a.employee_id)).toEqual(['1305']);
  });

  it('shows the row on the Matrix screen in English and in Arabic', async () => {
    await signIn('pm');
    renderApp(<MatrixPage />, { route: '/admin/matrix' });
    const row = await screen.findByTestId('matrix-row-permits_hse_te');
    expect(within(row).getByText('Permits & HSE - TE stream')).toBeInTheDocument();
    await i18n.changeLanguage('ar');
    try {
      expect(await within(await screen.findByTestId('matrix-row-permits_hse_te')).findByText('التصاريح والسلامة - مسار TE')).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
