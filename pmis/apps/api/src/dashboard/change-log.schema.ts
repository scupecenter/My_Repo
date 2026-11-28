import { z } from "zod";

/** GET /settings/change-log query (contract 0.15.433). */
export const changeLogQuerySchema = z
  .object({
    scope: z.enum(["dashboard", "goals"]),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
