import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { components } from "./schema";

/** F20 (contract 0.15.24): the global dashboard settings (targets, KPI thresholds, cards per tab and their order). */
type S = components["schemas"];
export type DashboardSettings = S["DashboardSettings"];
export type DashboardSettingsInput = S["DashboardSettingsInput"];
export type DashboardTab = "pmo" | "cw" | "te";

export const useDashboardSettings = () =>
  useQuery({
    queryKey: ["dashboardSettings"],
    queryFn: () => api.get<DashboardSettings>("/settings/dashboard"),
  });

export function useSetDashboardSettings() {
  const qc = useQueryClient();
  return useMutation<
    DashboardSettings,
    ApiError,
    { version: number; body: DashboardSettingsInput & { reason: string } }
  >({
    mutationFn: ({ version, body }) =>
      api.put("/settings/dashboard", { version, body }),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["dashboardSettings"] }),
  });
}
