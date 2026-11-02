import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Tx } from '../db/db.service';

/** DD6: how a workflow action was started. Recorded in the audit row by wf_audit / reg_audit; it changes no rule. */
export const viaSchema = z.enum(['button', 'drag', 'bulk']);
export type Via = z.infer<typeof viaSchema>;

/** Transaction-local: the database functions read it as current_setting('app.via'). */
export async function setVia(tx: Tx, via: Via | undefined): Promise<void> {
  if (via) await tx.$queryRaw(Prisma.sql`SELECT set_config('app.via', ${via}, true)`);
}
