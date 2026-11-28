import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { RegisterDefinition, RegisterField } from '@/api/types';
import { layoutsOf } from '@/components/RegisterViews';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

vi.mock('@/components/EChart', () => ({ EChart: ({ label, testid }: { label: string; testid?: string }) => <div role="img" aria-label={label} data-testid={testid} /> }));

/**
 * Decision V2: the register calendar. The Procurement register has date fields (PR Date first); Meetings has none and offers no Calendar. Synthetic mock
 * data only: the PRs of September 2026.
 */
const Where = () => { const l = useLocation(); return <output data-testid="where">{l.search}</output>; };
const App = () => <><Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes><Where /></>;
const where = () => screen.getByTestId('where').textContent ?? '';
const T = 20_000;

async function toMonth(u: ReturnType<typeof userEvent.setup>, title: RegExp) {
  for (let i = 0; i < 36; i++) {
    if (title.test(screen.getByTestId('register-calendar-title').textContent ?? '')) return;
    await u.click(screen.getByTestId('register-calendar-prev'));
  }
  throw new Error(`month ${title} not reached`);
}

describe('V2 register calendar', () => {
  it('Procurement: Calendar in the Layout panel, items on the PR Date, the field is chosen in the panel and kept in the URL', async () => {
    const u = userEvent.setup();
    await signIn('pm');
    renderApp(<App />, { route: '/registers/procurement' });
    await screen.findByTestId('register-list-card');
    await u.click(screen.getByTestId('register-view'));
    await u.click(await screen.findByTestId('register-layout-calendar'));
    expect(where()).toContain('layout=calendar');
    await screen.findByTestId('register-calendar');
    // the field select lives in the Layout panel options and defaults to the first date field (PR Date)
    await u.click(screen.getByTestId('register-view'));
    const sel = await screen.findByTestId('register-calendar-field');
    expect(sel).toHaveValue('pr_date');
    await toMonth(u, /September 2026/);
    const grid = screen.getByRole('grid');
    const cell = within(grid).getAllByRole('gridcell').find((c) => c.getAttribute('data-date') === '2026-09-02')!;
    expect(within(cell).getByTestId('register-calendar-item')).toHaveTextContent('TR101');
    // another date field through the panel, kept in the URL (the panel closed while the months were stepped: open it again)
    await u.click(screen.getByTestId('register-view'));
    await u.selectOptions(await screen.findByTestId('register-calendar-field'), 'po_wo_date');
    expect(where()).toContain('calf=po_wo_date');
    expect(where()).toContain('layout=calendar');
  }, T);

  it('layoutsOf: the calendar only where the definition has a date field', () => {
    const base = { register_key: 'x', name_en: 'X', name_ar: 'X', module_key: 'x', site_scoped: false, fields: [] } as unknown as RegisterDefinition;
    const dateF = { code: 'd1', name_en: 'D', name_ar: 'D', type: 'date' } as unknown as RegisterField;
    expect(layoutsOf({ ...base, fields: [{ code: 't', name_en: 'T', name_ar: 'T', type: 'text' } as unknown as RegisterField] })).toEqual(['list', 'wide', 'board', 'gallery', 'feed', 'chart']);
    expect(layoutsOf({ ...base, fields: [dateF] })).toEqual(['list', 'wide', 'board', 'gallery', 'feed', 'calendar', 'chart']);
    expect(layoutsOf({ ...base, site_scoped: true, fields: [dateF] })).toEqual(['list', 'wide', 'board', 'gallery', 'feed', 'map', 'calendar', 'chart']);
  });
});
