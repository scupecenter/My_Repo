import { z } from "zod";

/** PUT /settings/dashboard/forecast-window body (contract 0.15.431). The database checks the same rule again. */
export const forecastWindowPutSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    weeks: z.number().int().min(2).max(12),
  })
  .strict();
