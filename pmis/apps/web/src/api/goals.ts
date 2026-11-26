import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { components } from "./schema";

/** Goals with automatic progress (contract 0.15.99). */
type S = components["schemas"];
export type Goals = S["Goals"];
export type Goal = S["GoalInput"];
export type GoalProgress = S["GoalProgress"];

export const useGoals = () =>
  useQuery({
    queryKey: ["goals"],
    queryFn: () => api.get<Goals>("/settings/goals"),
  });

export const useGoalsProgress = () =>
  useQuery({
    queryKey: ["goalsProgress"],
    queryFn: () => api.get<{ goals: GoalProgress[] }>("/goals/progress"),
  });

export function useSetGoals() {
  const qc = useQueryClient();
  return useMutation<
    Goals,
    ApiError,
    { version: number; body: { goals: Goal[]; reason: string } }
  >({
    mutationFn: ({ version, body }) => api.put("/settings/goals", { version, body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["goals"] });
      void qc.invalidateQueries({ queryKey: ["goalsProgress"] });
    },
  });
}
