import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { components } from "./schema";

/** Per-user dashboard widgets (contract 0.15.585, migration 0713): the caller's own card order, hidden cards and layout templates. */
type S = components["schemas"];
export type UserDashboardLayouts = S["UserDashboardLayouts"];
export type UserDashboardTab = S["UserDashboardTab"];
export type UserDashboardTemplate = S["UserDashboardTemplate"];
export type UserDashboardTemplateLayouts = S["UserDashboardTemplateLayouts"];
export type WidgetTab = "pmo" | "cw" | "te";

const LAYOUT_KEY = ["my-dashboard-layout"] as const;
const TPL_KEY = ["my-dashboard-templates"] as const;

export const useMyDashboardLayouts = () =>
  useQuery({
    queryKey: LAYOUT_KEY,
    staleTime: 60_000,
    queryFn: async () => (await api.get<UserDashboardLayouts>("/me/dashboard-layout")).tabs,
  });

export const useMyDashboardTemplates = () =>
  useQuery({
    queryKey: TPL_KEY,
    staleTime: 60_000,
    queryFn: async () => (await api.get<{ items: UserDashboardTemplate[] }>("/me/dashboard-templates")).items,
  });

export function useMyDashboardWidgetOps() {
  const qc = useQueryClient();
  const layouts = () => void qc.invalidateQueries({ queryKey: LAYOUT_KEY });
  const templates = () => void qc.invalidateQueries({ queryKey: TPL_KEY });
  return {
    save: useMutation<unknown, ApiError, { tab: WidgetTab; order: string[]; hidden: string[]; version: number }>({
      mutationFn: ({ tab, ...body }) => api.put(`/me/dashboard-layout/${tab}`, { body }),
      onSettled: layouts,
    }),
    reset: useMutation<unknown, ApiError, WidgetTab>({
      mutationFn: (tab) => api.del(`/me/dashboard-layout/${tab}`),
      onSettled: layouts,
    }),
    saveTemplate: useMutation<unknown, ApiError, { name: string; layouts: UserDashboardTemplateLayouts }>({
      mutationFn: (body) => api.post("/me/dashboard-templates", { body }),
      onSettled: templates,
    }),
    applyTemplate: useMutation<unknown, ApiError, string>({
      mutationFn: (id) => api.post(`/me/dashboard-templates/${id}/apply`, { body: {} }),
      onSettled: () => { layouts(); templates(); },
    }),
    deleteTemplate: useMutation<unknown, ApiError, string>({
      mutationFn: (id) => api.del(`/me/dashboard-templates/${id}`),
      onSettled: templates,
    }),
  };
}
