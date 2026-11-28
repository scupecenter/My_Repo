import { z } from "zod";

/** PUT /settings/dashboard body (contract 0.15.24). The database checks the same rules again and answers field errors. */
const code = z.string().min(1).max(60);
const layout = z
  .object({
    order: z.array(code).max(60),
    hidden: z.array(code).max(60),
  })
  .strict();
const whole = z.number().int().min(0).max(100000).nullable();

export const dashboardSettingsPutSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    targets: z
      .object({ sites_per_batch: whole, monthly_on_air: whole })
      .strict(),
    thresholds: z.record(
      z.string(),
      z.object({ green: z.number(), amber: z.number() }).strict(),
    ),
    tabs: z.object({ pmo: layout, cw: layout, te: layout }).strict(),
    // 0.15.29 (migration 0113): optional; absent keeps the stored value
    stale_idle_days: z.number().int().min(1).max(30).optional(),
  })
  .strict();

/** PUT /settings/dashboard/health-bands body (contract 0.15.435). The database checks the same rules again (green above amber, whole numbers). */
export const healthBandsPutSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    green: z.number().int().min(1).max(100),
    amber: z.number().int().min(0).max(99),
  })
  .strict();
