import { z } from "zod";

/** PUT /settings/pm-schedules body (contract 0.15.161). The database checks the same rules again and answers field errors. */
const schedule = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,40}$/),
    name_en: z.string().trim().min(1).max(120),
    name_ar: z.string().trim().max(120).nullable().optional(),
    register_key: z.string().min(1).max(60),
    site_id: z.guid().nullable().optional(),
    record_type: z.string().max(40).nullable().optional(),
    data: z.record(z.string(), z.unknown()),
    every: z.number().int().min(1).max(52),
    unit: z.enum(["week", "month"]),
    next_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    active: z.boolean().optional(),
  })
  .strict();

export const pmSchedulesPutSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    schedules: z.array(schedule).max(100),
  })
  .strict();
