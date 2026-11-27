import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { components } from './schema';

/** Contract 0.15.185 (migration 0280): the interface features, a general setting (Administration > Settings > Screens > Interface). */
export type UiFeaturesSetting = components['schemas']['UiFeaturesSetting'];
export type UiFeatures = components['schemas']['UiFeatures'];
export type UiFeaturesPatch = components['schemas']['UiFeaturesPatch'];

/** The look before anything is saved (the seed of the migration), also used while the setting loads. */
export const UI_FEATURES_SEED: UiFeatures = {
  avatars: { style: 'gradient', shape: 'circle', palette: 'varied', in_lists: true },
  new_badge: { enabled: true, days: 14 },
  data_hub: {
    widgets: { quick_bar: true, batches: true, template_changes: true, recent: true, health: true, admin: true }, badge: true,
    default_view: { templates: 'cards', uploads: 'table', exports: 'table', master_import: 'table' },
  },
  inbox: { tabs_enabled: true, default_tab: 'all', priority_kinds: ['mention', 'approval_due', 'task_returned', 'task_rejected', 'idle_task_alert', 'no_holder', 'absence_alert'] },
  panel: { mode: 'popover', width: 'medium', show_tabs: true },
  field_pwa: { enabled: false, cache_hours: 24, max_queue: 50, max_photo_mb: 8, sync_seconds: 60 },
  unsaved_guard: { enabled: true, settings: true, dialogs: true, drawers: true, inline: true, composers: true, navigation: true },
};

export const useUiFeaturesSetting = (enabled = true) =>
  useQuery({ queryKey: ['ui-features'], enabled, staleTime: 300_000, retry: false, queryFn: () => api.get<UiFeaturesSetting>('/settings/ui-features') });

/** Every section, each one complete; the seed fills what the server did not send. */
export function useUiFeatures(): UiFeatures {
  const q = useUiFeaturesSetting();
  return { ...UI_FEATURES_SEED, ...q.data?.sections };
}

/** PUT /settings/ui-features: a System Admin or an all-regions delegate of admin.settings, a reason and If-Match. */
export function useSaveUiFeatures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { sections: UiFeaturesPatch; reason: string; version: number }) =>
      api.put<UiFeaturesSetting>('/settings/ui-features', { version: v.version, body: { sections: v.sections, reason: v.reason } }),
    onSuccess: (r) => qc.setQueryData(['ui-features'], r),
  });
}
