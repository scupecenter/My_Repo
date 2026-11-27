import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

/** Migration 0366: the new saved-view screens know their module (the region scope of shared views); the older screens keep theirs. */
let db: PgClient;
beforeAll(async () => { db = await superDb(); });
afterAll(async () => { await db.end(); });
const mod = async (s: string) => (await db.query(`SELECT sv_screen_module($1) AS m`, [s])).rows[0].m as string | null;

describe('sv_screen_module', () => {
  it('maps the Warehouse lists and the Library forms, keeps the earlier screens, leaves the personal lists without a module', async () => {
    for (const s of ['warehouse-items', 'warehouse-movements', 'warehouse-stock', 'warehouse-dispatch']) expect(await mod(s)).toBe('warehouse');
    expect(await mod('library-forms')).toBe('sites.documents');
    expect(await mod('library-archive')).toBe('sites.documents');
    expect(await mod('sites')).toBe('sites');
    expect(await mod('audit-log')).toBe('audit');
    expect(await mod('daily-plan')).toBe('daily_plan');
    expect(await mod('inbox')).toBeNull();
    expect(await mod('messages')).toBeNull();
  });
});
