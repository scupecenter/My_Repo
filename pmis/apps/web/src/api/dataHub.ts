import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { components } from './schema';
import { useUiFeatures } from './uiFeatures';

/** Contract 0.15.270 (migration 0400): the Data hub landing page. */
export type DataHubSummary = components['schemas']['DataHubSummary'];
export type DataHubBatch = components['schemas']['DataHubBatch'];
export type DataHubTemplateChange = components['schemas']['DataHubTemplateChange'];
export type DataHubDownload = components['schemas']['DataHubDownload'];
export type UiDataHub = components['schemas']['UiDataHub'];
export type HubView = 'cards' | 'rows' | 'table' | 'compact';
export type HubScreen = keyof UiDataHub['default_view'];
export type HubWidget = keyof UiDataHub['widgets'];

export const HUB_VIEWS: readonly HubView[] = ['cards', 'rows', 'table', 'compact'];
export const HUB_WIDGETS: readonly HubWidget[] = ['quick_bar', 'batches', 'template_changes', 'recent', 'health', 'admin'];
export const HUB_SCREENS: readonly HubScreen[] = ['templates', 'uploads', 'exports', 'master_import'];

/** The look before anything is saved (the seed of migration 0400). */
export const DATA_HUB_SEED: UiDataHub = {
  widgets: { quick_bar: true, batches: true, template_changes: true, recent: true, health: true, admin: true },
  badge: true,
  default_view: { templates: 'cards', uploads: 'table', exports: 'table', master_import: 'table' },
};

/** The Data hub setting (Settings > Screens > Data hub), complete. */
export function useDataHubSettings(): UiDataHub {
  const d = useUiFeatures().data_hub as Partial<UiDataHub> | undefined;
  return { ...DATA_HUB_SEED, ...d, widgets: { ...DATA_HUB_SEED.widgets, ...d?.widgets }, default_view: { ...DATA_HUB_SEED.default_view, ...d?.default_view } };
}

/** GET /data-hub/summary: batches waiting for the caller, template changes and the caller's last downloads. Polled lightly while the page is open. */
export const useDataHubSummary = (enabled = true) =>
  useQuery({ queryKey: ['data-hub', 'summary'], enabled, staleTime: 15_000, refetchInterval: 60_000, refetchIntervalInBackground: false, queryFn: () => api.get<DataHubSummary>('/data-hub/summary') });
