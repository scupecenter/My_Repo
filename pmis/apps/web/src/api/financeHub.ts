import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { components } from './schema';
import { useUiFeatures } from './uiFeatures';

/** Contract 0.15.312 (migration 0406): the Finance hub landing page. */
export type FinanceHubSummary = components['schemas']['FinanceHubSummary'];
export type UiFinanceHub = components['schemas']['UiFinanceHub'];
export type FinanceWidget = keyof UiFinanceHub['widgets'];

export const FINANCE_WIDGETS: readonly FinanceWidget[] = ['advances', 'invoices', 'quick_links', 'templates'];

/** The look before anything is saved (the seed of migration 0406). */
export const FINANCE_HUB_SEED: UiFinanceHub = {
  widgets: { advances: true, invoices: true, quick_links: true, templates: true },
  settle_warn_days: 30,
  aging_days: [30, 60],
};

/** The Finance hub setting (Settings > Screens > Finance hub), complete. */
export function useFinanceHubSettings(): UiFinanceHub {
  const d = useUiFeatures().finance_hub as Partial<UiFinanceHub> | undefined;
  return { ...FINANCE_HUB_SEED, ...d, widgets: { ...FINANCE_HUB_SEED.widgets, ...d?.widgets } };
}

/** GET /finance-hub/summary: the read-only register cards. Polled lightly while the page is open. */
export const useFinanceHubSummary = (enabled = true) =>
  useQuery({ queryKey: ['finance-hub', 'summary'], enabled, staleTime: 15_000, refetchInterval: 60_000, refetchIntervalInBackground: false, queryFn: () => api.get<FinanceHubSummary>('/finance-hub/summary') });
