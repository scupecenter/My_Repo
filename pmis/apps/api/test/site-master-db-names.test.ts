import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

/** Migration 0158: the database names "site360..." became "site_master...", and nothing in public still carries the old name. */
let db: PgClient;
beforeAll(async () => {
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

describe('Site Master database names (0158)', () => {
  it('has the renamed view, column and functions and no function, view or column with the old name', async () => {
    const q = async (sql: string): Promise<{ n: string }[]> => (await db.query(sql)).rows as { n: string }[];
    expect((await q(`SELECT count(*)::text AS n FROM pg_views WHERE schemaname = 'public' AND viewname IN ('site_master_values', 'site_master_task_cells')`))[0]!.n).toBe('2');
    expect((await q(`SELECT count(*)::text AS n FROM information_schema.columns WHERE table_name = 'master_columns' AND column_name = 'site_master_sections'`))[0]!.n).toBe('1');
    expect((await q(`SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname IN ('site_master_set_sections', 'site_master_column_create', 'site_master_col_can_admin')`))[0]!.n).toBe('3');
    expect((await q(`SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND (p.proname LIKE 'site360%' OR p.prosrc LIKE '%site360%')`))[0]!.n).toBe('0');
    expect((await q(`SELECT count(*)::text AS n FROM pg_views WHERE schemaname = 'public' AND (viewname LIKE 'site360%' OR definition LIKE '%site360%')`))[0]!.n).toBe('0');
    expect((await q(`SELECT count(*)::text AS n FROM saved_views WHERE screen_key LIKE 'site360-%'`))[0]!.n).toBe('0');
  });

  it('keeps the grants of the renamed functions: the door is callable by the application role and not by PUBLIC', async () => {
    const r = await db.query(
      `SELECT p.proname, p.prosecdef, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public' AND p.proname IN ('site_master_set_sections', 'site_master_column_create')`,
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows as { prosecdef: boolean; public_exec: boolean }[]) {
      expect(row.prosecdef).toBe(true);
      expect(row.public_exec).toBe(false);
    }
  });
});
