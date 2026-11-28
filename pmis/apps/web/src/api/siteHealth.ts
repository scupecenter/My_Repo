import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { components } from "./schema";

/** Site health score (contract 0.15.591, migration 0714): one score and colour per site, and the weights of its four factors. */
type S = components["schemas"];
export type SiteHealthList = S["SiteHealthList"];
export type SiteHealthItem = S["SiteHealthItem"];
export type SiteHealthDetail = S["SiteHealthDetail"];
export type SiteHealthWeights = S["SiteHealthWeights"];
export type SiteHealthBand = S["SiteHealthBand"];

export const useSiteHealth = (band: SiteHealthBand | "", q: string) =>
  useQuery({
    queryKey: ["siteHealth", band, q],
    staleTime: 30_000,
    queryFn: () =>
      api.get<SiteHealthList>("/dashboard/site-health", { query: { limit: 15, ...(band ? { band } : {}), ...(q.trim() ? { q: q.trim() } : {}) } }),
  });

export const useSiteHealthDetail = (siteId: string | null) =>
  useQuery({
    queryKey: ["siteHealthDetail", siteId],
    enabled: !!siteId,
    queryFn: () => api.get<SiteHealthDetail>(`/dashboard/site-health/${siteId}`),
  });

export const useSiteHealthWeights = () =>
  useQuery({
    queryKey: ["siteHealthWeights"],
    queryFn: () => api.get<SiteHealthWeights>("/settings/dashboard/site-health-weights"),
  });

export function useSetSiteHealthWeights() {
  const qc = useQueryClient();
  return useMutation<
    SiteHealthWeights,
    ApiError,
    { version: number; body: { tasks: number; docs: number; snags: number; delay: number; reason: string } }
  >({
    mutationFn: ({ version, body }) => api.put("/settings/dashboard/site-health-weights", { version, body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["siteHealthWeights"] });
      void qc.invalidateQueries({ queryKey: ["siteHealth"] });
      void qc.invalidateQueries({ queryKey: ["siteHealthDetail"] });
    },
  });
}
