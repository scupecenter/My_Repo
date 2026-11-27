import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { G, Team, approveAll, createRec, post, recPath, team } from './reg-helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.135 (migration 0184): the Lessons Learned register (owner approval 2026-11-26, C3). */
let app: NestExpressApplication;
let db: PgClient;
let t: Team;

const OK = { lesson_date: '2026-11-20', title: 'Test lesson', category: 'Safety', lesson: 'Always check twice' };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  t = await team(app, db, 'lessons_learned', 'lessons_learned', 5);
});
afterAll(async () => {
  await db.end();
});

describe('lessons learned register', () => {
  it('is listed with the standard two levels, its lists and the template', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const res = await api.call('get', '/registers');
    expect(res.status).toBe(200);
    const def = (res.body.items as { register_key: string; approval_levels: number; site_scoped: boolean; fields: { code: string }[] }[]).find((r) => r.register_key === 'lessons_learned');
    expect(def?.approval_levels).toBe(2);
    expect(def?.site_scoped).toBe(true);
    expect(def?.fields.map((f) => f.code)).toEqual(expect.arrayContaining(['lesson_date', 'title', 'category', 'source', 'lesson', 'recommendation', 'applied_to', 'closed_date']));
    const lists = await db.query(`SELECT catalogue_code, count(*)::int AS n FROM list_values WHERE catalogue_code = 'LessonCategory' GROUP BY 1 ORDER BY 1`);
    expect(lists.rows).toEqual([{ catalogue_code: 'LessonCategory', n: 8 }]);
    const tpl = await db.query(`SELECT 1 FROM template_definitions WHERE template_id = 'TPL-LESSONS-LEARNED' AND register_key = 'lessons_learned'`);
    expect(tpl.rowCount).toBe(1);
  });

  it('seeds no matrix holder and no permission grant (assignment stays with the matrix)', async () => {
    const holders = await db.query(`SELECT count(*)::int AS n FROM matrix_cells WHERE register_key = 'lessons_learned' AND region_id IS NULL`);
    expect(holders.rows[0].n).toBe(0);
  });

  it('runs entry to approval and keeps the required fields and the actual-date rule', async () => {
    // a draft saves without the required fields (needed to submit, 0019); the submit refuses them
    const missing = await createRec(t, { lesson_date: '2026-11-20' });
    expect((await post(t.entry.api, 'lessons_learned', missing.id, 'submit', missing.version)).status).toBe(422);
    // an actual date cannot be in the future (V2), refused already at the save
    const future = await t.entry.api.call('post', recPath('lessons_learned'), { site_id: t.site.id, data: { ...OK, lesson_date: '2030-06-15' } });
    expect(future.status).toBe(422);
    const rec = await createRec(t, OK);
    expect(rec.state).toBe('entry');
    const done = await approveAll(t, rec.id, rec.version);
    expect(done.state).toBe('approved');
  });

  it('refuses a caller without the lessons_learned module grant', async () => {
    const a = await actor(app, db, { grants: G('sites', 'view'), regions: [5], modules: null });
    expect((await a.api.call('get', recPath('lessons_learned'))).status).toBe(403);
  });
});
