import { z } from "zod";

/** PUT /settings/goals body (contract 0.15.150). The database checks the same rules again and answers field errors. */
const goal = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,40}$/),
    name_en: z.string().trim().min(1).max(120),
    name_ar: z.string().trim().max(120).nullable().optional(),
    metric: z.string().min(1).max(60),
    region_id: z.number().int().min(1).max(7).nullable().optional(),
    period: z.enum(["month", "quarter", "year"]),
    target: z.number().int().min(1).max(100000),
    active: z.boolean().optional(),
  })
  .strict();

export const goalsPutSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    goals: z.array(goal).max(50),
  })
  .strict();
