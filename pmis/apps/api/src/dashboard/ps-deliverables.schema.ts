import { z } from "zod";

/** PUT /settings/dashboard/ps-deliverables body (contract 0.15.470). The database checks the same rules again. */
export const psDeliverablesPutSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    items: z
      .array(
        z
          .object({
            item_code: z.string().trim().min(1).max(20),
            kind: z.string().trim().min(1).max(80).nullable().optional(),
            mode: z.enum(["auto", "manual"]),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
