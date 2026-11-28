import { z } from "zod";

/** PUT /settings/dashboard/snapshot-schedule body (contract 0.15.430). The database checks the same rule again. */
export const snapshotWeekdayPutSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    weekday: z.number().int().min(0).max(6),
  })
  .strict();
