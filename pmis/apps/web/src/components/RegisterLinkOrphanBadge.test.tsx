import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { RegisterLinkOrphanBadge } from './RegisterLinkOrphanBadge';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { n?: number }) => (o?.n !== undefined ? `${k}:${o.n}` : k) }) }));
vi.mock('@/api/p4c', () => ({
  useRegisterLinkOrphans: () => ({ data: [
    { register_key: 'issues', field_code: 'risk_entity_id', target_register: 'risks', rows_with_value: 10, orphan_rows: 3 },
    { register_key: 'warehouse', field_code: 'procurement_order_id', target_register: 'procurement', rows_with_value: 4, orphan_rows: 0 },
  ] }),
}));
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe('RegisterLinkOrphanBadge', () => {
  it('shows the count when rows hold an orphan id', () => {
    wrap(<RegisterLinkOrphanBadge register="issues" field="risk_entity_id" />);
    expect(screen.getByTestId('link-orphans-issues-risk_entity_id').textContent).toBe('linkOrphans.badge_orphans:3');
  });
  it('shows clean when there is none, and nothing for an unknown link', () => {
    wrap(<><RegisterLinkOrphanBadge register="warehouse" field="procurement_order_id" /><RegisterLinkOrphanBadge register="x" field="y" /></>);
    expect(screen.getByTestId('link-orphans-warehouse-procurement_order_id')).toBeTruthy();
    expect(screen.queryByTestId('link-orphans-x-y')).toBeNull();
  });
});
