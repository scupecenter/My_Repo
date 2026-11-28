import { z } from "zod";

const item = z
  .object({
    enabled: z.boolean(),
    green: z.number().finite(),
    amber: z.number().finite(),
  })
  .strict();

/** PUT /settings/dashboard/progress-rag body (contract 0.15.432). The database checks the ranges and the order again. */
export const progressRagPutSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    items: z.object({ spi: item, progress_gap: item, velocity: item }).strict(),
  })
  .strict();
