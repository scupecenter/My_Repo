import { z } from "zod";

/** PUT /settings/dashboard/forecast-method body (contract 0.15.474). The database checks the same rule again. */
export const forecastMethodPutSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    method: z.enum(["mean", "linear"]),
  })
  .strict();
