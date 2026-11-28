import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";

/** Migration 0543: partial credit for in-progress tasks (off by default). */
export type PartialCredit = {
  enabled: boolean;
  version: number;
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
};

export const usePartialCredit = () =>
  useQuery({ queryKey: ["partialCredit"], queryFn: () => api.get<PartialCredit>("/settings/partial-credit") });

export function useSetPartialCredit() {
  const qc = useQueryClient();
  return useMutation<PartialCredit, ApiError, { version: number; body: { enabled: boolean; reason: string } }>({
    mutationFn: ({ version, body }) => api.put("/settings/partial-credit", { version, body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["partialCredit"] }),
  });
}
