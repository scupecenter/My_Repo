import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";

/** 0.15.475 (D8): outbound notifications to a webhook or an email address. Off by default; Settings > Alerts > Outbound. */
export interface OutboundDestination {
  id: string;
  kind: "webhook" | "email";
  label: string;
  target: string;
  has_secret: boolean;
  events: string[];
  active: boolean;
  archived_at: string | null;
  updated_at: string;
  queued: number;
  dead: number;
}
export interface OutboundOverview {
  enabled: boolean;
  locked: boolean;
  version: number;
  event_kinds: string[];
  destinations: OutboundDestination[];
}
export interface OutboundDelivery {
  id: string;
  destination: string;
  kind: string;
  event: string;
  status: "queued" | "sent" | "dead" | "blocked";
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}
export interface OutboundDestinationInput {
  kind: "webhook" | "email";
  label: string;
  target: string;
  secret?: string;
  events: string[];
  active: boolean;
  reason: string;
}

const KEY = ["outboundIntegrations"];
const BASE = "/settings/integrations/outbound";

export const useOutbound = () => useQuery({ queryKey: KEY, queryFn: () => api.get<OutboundOverview>(BASE) });
export const useOutboundDeliveries = () =>
  useQuery({ queryKey: ["outboundDeliveries"], queryFn: () => api.get<{ items: OutboundDelivery[] }>(`${BASE}/deliveries`) });

export function useSetOutboundEnabled() {
  const qc = useQueryClient();
  return useMutation<OutboundOverview, ApiError, { version: number; body: { enabled: boolean; reason: string } }>({
    mutationFn: ({ version, body }) => api.put(`${BASE}/enabled`, { version, body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSaveOutboundDestination() {
  const qc = useQueryClient();
  return useMutation<OutboundOverview, ApiError, { id?: string; body: OutboundDestinationInput }>({
    mutationFn: ({ id, body }) => (id ? api.put(`${BASE}/destinations/${id}`, { body }) : api.post(`${BASE}/destinations`, { body })),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useArchiveOutboundDestination() {
  const qc = useQueryClient();
  return useMutation<OutboundOverview, ApiError, { id: string; archived: boolean; reason: string }>({
    mutationFn: ({ id, archived, reason }) => api.post(`${BASE}/destinations/${id}/archive`, { body: { archived, reason } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
