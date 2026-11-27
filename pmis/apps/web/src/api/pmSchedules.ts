import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { components } from "./schema";

/** Preventive-maintenance schedules that create drafts only (contract 0.15.161). */
type S = components["schemas"];
export type PmSchedules = S["PmSchedules"];
export type PmSchedule = S["PmSchedule"];
export type PmScheduleInput = S["PmScheduleInput"];

export const usePmSchedules = () =>
  useQuery({ queryKey: ["pmSchedules"], queryFn: () => api.get<PmSchedules>("/settings/pm-schedules") });

export function useSetPmSchedules() {
  const qc = useQueryClient();
  return useMutation<PmSchedules, ApiError, { version: number; body: { schedules: PmScheduleInput[]; reason: string } }>({
    mutationFn: ({ version, body }) => api.put("/settings/pm-schedules", { version, body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["pmSchedules"] }),
  });
}

/** One draft, saved as the caller by the register's own create path; the next due date then moves on. */
export function useGeneratePmDraft() {
  const qc = useQueryClient();
  return useMutation<{ record_id: string; register_key: string; next_due: string | null }, ApiError, string>({
    mutationFn: (id) => api.post(`/pm-schedules/${id}/generate`),
    onSettled: (_d, _e, _id) => {
      void qc.invalidateQueries({ queryKey: ["pmSchedules"] });
      void qc.invalidateQueries({ queryKey: ["register-records"] });
    },
  });
}

/** The schedules that are due today and switched on. */
export const dueSchedules = (s: PmSchedules | undefined, registerKey?: string): PmSchedule[] =>
  (s?.schedules ?? []).filter((x) => x.active !== false && x.next_due <= s!.today && (!registerKey || x.register_key === registerKey));

/** A new id from the English name: lower case, a-z 0-9 and hyphen, unique in the list. */
export function scheduleId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "schedule";
  let id = base.length >= 3 ? base : `${base}-pm`;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`.slice(0, 40);
  return id;
}
