import { z } from "zod";

/** Bodies of the per-user dashboard widgets (contract 0.15.585). The database checks the card codes and duplicates again. */
const code = z.string().min(1).max(60);
export const tabSchema = z.enum(["pmo", "cw", "te"]);

/** `version` is the version read with the layout (0 for a tab the caller has not customised yet). */
export const layoutSaveSchema = z
  .object({
    order: z.array(code).max(60),
    hidden: z.array(code).max(60),
    version: z.number().int().min(0),
  })
  .strict();

const tabLayout = z
  .object({ order: z.array(code).max(60), hidden: z.array(code).max(60) })
  .strict();

export const templateSaveSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    layouts: z
      .object({ pmo: tabLayout.optional(), cw: tabLayout.optional(), te: tabLayout.optional() })
      .strict(),
  })
  .strict();
