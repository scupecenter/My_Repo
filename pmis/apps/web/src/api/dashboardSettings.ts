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

/** 0.15.430 (settings review gap 3): the weekday of the weekly dashboard snapshot. Kept in the setting dashboard.snapshot_weekday. */
export type SnapshotSchedule = S["SnapshotSchedule"];

export const useSnapshotSchedule = () =>
  useQuery({
    queryKey: ["snapshotSchedule"],
    queryFn: () =>
      api.get<SnapshotSchedule>("/settings/dashboard/snapshot-schedule"),
  });

export function useSetSnapshotSchedule() {
  const qc = useQueryClient();
  return useMutation<
    SnapshotSchedule,
    ApiError,
    { version: number; body: { weekday: number; reason: string } }
  >({
    mutationFn: ({ version, body }) =>
      api.put("/settings/dashboard/snapshot-schedule", { version, body }),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["snapshotSchedule"] }),
  });
}

/** 0.15.435 (settings review gap 8): the health index bands, green and amber. Kept in the setting dashboard.health_bands. */
export type HealthBands = S["HealthBands"];

export const useHealthBands = () =>
  useQuery({
    queryKey: ["healthBands"],
    queryFn: () => api.get<HealthBands>("/settings/dashboard/health-bands"),
  });

export function useSetHealthBands() {
  const qc = useQueryClient();
  return useMutation<
    HealthBands,
    ApiError,
    {
      version: number;
      body: { green: number; amber: number; reason: string };
    }
  >({
    mutationFn: ({ version, body }) =>
      api.put("/settings/dashboard/health-bands", { version, body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["healthBands"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

/** 0.15.432 (settings review gap 5): green and amber thresholds of the SPI, the progress against plan and the weekly velocity. Kept in the setting dashboard.progress_rag. */
export type ProgressRag = S["ProgressRag"];
export type ProgressRagInput = S["ProgressRagInput"];

export const useProgressRag = () =>
  useQuery({
    queryKey: ["progressRag"],
    queryFn: () => api.get<ProgressRag>("/settings/dashboard/progress-rag"),
  });

export function useSetProgressRag() {
  const qc = useQueryClient();
  return useMutation<
    ProgressRag,
    ApiError,
    { version: number; body: ProgressRagInput & { reason: string } }
  >({
    mutationFn: ({ version, body }) =>
      api.put("/settings/dashboard/progress-rag", { version, body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["progressRag"] }),
  });
}
