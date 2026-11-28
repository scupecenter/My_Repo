import { z } from "zod";

export const siteHealthQuerySchema = z
  .object({
    region_id: z.coerce.number().int().positive().optional(),
    band: z.enum(["green", "amber", "red"]).optional(),
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const siteHealthWeightsPutSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    tasks: z.number().int().min(0).max(100),
    docs: z.number().int().min(0).max(100),
    snags: z.number().int().min(0).max(100),
    delay: z.number().int().min(0).max(100),
  })
  .strict();
