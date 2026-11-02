import { Prisma } from '@prisma/client';
import type { Tx } from '../db/db.service';

/**
 * X3: the people a comment names: the ids sent by the client plus `@1234` employee-ID tokens in the text. Unknown or inactive IDs are dropped
 * silently, so the answer never says whether a person exists. The database then keeps only those who can read the record.
 */
export async function resolveMentions(tx: Tx, body: string, ids: string[] | undefined): Promise<string[]> {
  const codes = [...new Set([...body.matchAll(/(?:^|[\s(])@(\d{4})\b/g)].map((m) => m[1] as string))].slice(0, 20);
  const out = new Set(ids ?? []);
  if (codes.length > 0) {
    const rows = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id::text AS id FROM users WHERE employee_id = ANY(${codes}::text[]) AND status = 'active' AND deleted_at IS NULL AND NOT is_break_glass`);
    for (const r of rows) out.add(r.id);
  }
  return [...out].slice(0, 20);
}
