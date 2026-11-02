import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * X7, weekly status updates (migration 0031, the lead check on edit in 0040). Regions 6 and 7. The lists are filtered by author, because other suites write
 * updates too. Weeks are fixed Sundays of January 2026, so no figure depends on today's date or the weekday.
 */
const A = 6;
const B = 7;
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const LEAD_GRANTS: [string, string][] = [...G('sites', 'view'), ['overrides.reassign', 'administer']];
const lead = (regions: number[] | null = [A]) => actor(app, db, { level: 'approve', grants: LEAD_GRANTS, regions, modules: null });
const reader = (regions: number[] | null = [A]) => actor(app, db, { level: 'view', grants: G('sites', 'view'), regions, modules: null });
const input = (o: Record<string, unknown> = {}) => ({ scope: 'region', region_id: A, health: 'on_track', summary: 'All on plan.', ...o });
const anon = (m: 'get' | 'post' | 'patch', p: string) => request(app.getHttpServer())[m](`${API}${p}`);
const audits = async (action: string, id: string) => (await db.query('SELECT actor_id::text, region_id, before, after FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', [action, id])).rows;

/** A past update written straight into the table (the superuser), on a fixed Sunday. */
async function old(author: Actor, week: string, o: { region?: number | null; team?: string | null; scope?: string; summary?: string } = {}): Promise<string> {
  const scope = o.scope ?? (o.team ? 'team' : 'region');
  const r = await db.query(
    `INSERT INTO status_updates (scope, region_id, team, week_start, health, summary, author_id)
     VALUES ($1, $2, $3, $4::date, 'on_track', $5, $6) RETURNING id::text AS id`,
    [scope, o.region === undefined ? A : o.region, o.team ?? null, week, o.summary ?? `old ${week}`, author.user.id],
  );
  return r.rows[0].id as string;
}
const mine = (res: { body: { items: { id: string; author: { id: string } }[] } }, who: Actor) => res.body.items.filter((i) => i.author.id === who.user.id);

describe('X7 who may call it', () => {
  it('needs a session (401) and the Sites module (403) to read or write', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect((await anon('get', '/status-updates')).status).toBe(401);
    expect((await anon('post', '/status-updates').send(input())).status).toBe(401);
    expect((await anon('patch', `/status-updates/${id}`).set('If-Match', '"1"').send({ health: 'at_risk' })).status).toBe(401);
    const noSites = await actor(app, db, { level: 'view', grants: [...G('approvals', 'view'), ['overrides.reassign', 'administer']], regions: [A], modules: null });
    expect((await noSites.api.call('get', '/status-updates')).status).toBe(403);
    expect((await noSites.api.call('post', '/status-updates', input())).status).toBe(403);
    expect((await noSites.api.call('patch', `/status-updates/${id}`, { health: 'at_risk' }, { 'If-Match': '"1"' })).status).toBe(403);
  });

  it('writes only for a lead of that region (or an admin); the lead of another region, a reader and a lead without Sites are refused and nothing is stored', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM status_updates')).rows[0].n as number;
    const leadB = await lead([B]);
    const r = await reader();
    const onlyReassign = await actor(app, db, { level: 'approve', grants: [['overrides.reassign', 'administer']], regions: [A], modules: null });
    expect((await leadB.api.call('post', '/status-updates', input())).status).toBe(403); // a lead of region B writes for region A
    expect((await r.api.call('post', '/status-updates', input())).status).toBe(403);
    expect((await onlyReassign.api.call('post', '/status-updates', input())).status).toBe(403);
    // a team update with no region covers all regions and needs the right in all of them
    const regional = await lead([A]);
    expect((await regional.api.call('post', '/status-updates', { scope: 'team', team: 'cw', health: 'at_risk', summary: 'Everywhere.' })).status).toBe(403);
    const everywhere = await lead(null);
    expect((await everywhere.api.call('post', '/status-updates', { scope: 'team', team: 'cw', health: 'at_risk', summary: 'Everywhere.' })).status).toBe(201);
    expect((await db.query('SELECT count(*)::int AS n FROM status_updates')).rows[0].n).toBe(before + 1);
    // an admin writes for any region
    const admin = await plainAdmin(app, db);
    expect((await admin.api.call('post', '/status-updates', input({ region_id: B }))).status).toBe(201);
  });
});

describe('X7 the week and the audit', () => {
  it('opens the update in the current working week (a Sunday, six days long) and audits the post and the edit with before and after', async () => {
    const l = await lead();
    const c = await l.api.call('post', '/status-updates', input({ summary: '  Padded.  ' }));
    expect(c.status).toBe(201);
    expect(c.body.summary).toBe('Padded.');
    const today = (await db.query(`SELECT cal_today()::text AS d, (cal_today() - extract(dow FROM cal_today())::int)::text AS sunday, (cal_today() - extract(dow FROM cal_today())::int + 6)::text AS saturday`)).rows[0];
    expect([c.body.week_start, c.body.week_end]).toEqual([today.sunday, today.saturday]);
    expect(new Date(`${c.body.week_start}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(c.headers.etag).toBe('"1"');
    const posted = await audits('status_update_post', c.body.id);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ actor_id: l.user.id, region_id: A, after: { scope: 'region', health: 'on_track', summary: 'Padded.' } });

    const e = await l.api.call('patch', `/status-updates/${c.body.id}`, { health: 'off_track', summary: 'Now late.' }, { 'If-Match': '"1"' });
    expect(e.status).toBe(200);
    expect(e.headers.etag).toBe('"2"');
    expect(e.body).toMatchObject({ health: 'off_track', summary: 'Now late.', version: 2, editable: true });
    expect((await audits('status_update_edit', c.body.id))[0]).toMatchObject({ before: { health: 'on_track', summary: 'Padded.' }, after: { health: 'off_track', summary: 'Now late.' } });
  });

  it('edits only with a fresh If-Match (428 without, 412 stale), a non-empty known-key body (422) and an id that exists in the caller\'s regions (404)', async () => {
    const l = await lead();
    const c = await l.api.call('post', '/status-updates', input());
    const url = `/status-updates/${c.body.id}`;
    expect((await l.api.call('patch', url, { health: 'at_risk' })).status).toBe(428);
    expect((await l.api.call('patch', url, { health: 'at_risk' }, { 'If-Match': '"7"' })).status).toBe(412);
    for (const body of [{}, { health: 'fine' }, { summary: '' }, { summary: 'x'.repeat(4001) }, { health: 'at_risk', region_id: B }, { author_id: l.user.id }]) {
      expect((await l.api.call('patch', url, body, { 'If-Match': '"1"' })).status, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    expect((await l.api.call('patch', '/status-updates/not-a-uuid', { health: 'at_risk' }, { 'If-Match': '"1"' })).status).toBe(404);
    expect((await l.api.call('patch', '/status-updates/00000000-0000-4000-8000-000000000002', { health: 'at_risk' }, { 'If-Match': '"1"' })).status).toBe(404);
    expect((await db.query('SELECT version FROM status_updates WHERE id = $1', [c.body.id])).rows[0].version).toBe(1);
  });

  it('lets only the author edit, and only while still a lead of the region (the right taken away stops the edit)', async () => {
    const l = await lead();
    const colleague = await lead();
    const c = await l.api.call('post', '/status-updates', input());
    const url = `/status-updates/${c.body.id}`;
    expect((await colleague.api.call('patch', url, { health: 'at_risk' }, { 'If-Match': '"1"' })).status).toBe(403);
    expect((await (await reader()).api.call('patch', url, { health: 'at_risk' }, { 'If-Match': '"1"' })).status).toBe(403);
    // a person outside the region does not even learn that it exists
    expect((await (await lead([B])).api.call('patch', url, { health: 'at_risk' }, { 'If-Match': '"1"' })).status).toBe(404);
    await db.query(
      `DELETE FROM permission_grants WHERE module_key = 'overrides.reassign' AND profile_id IN
         (SELECT ap.profile_id FROM user_role_assignment_profiles ap JOIN user_role_assignments ua ON ua.id = ap.assignment_id WHERE ua.user_id = $1)`,
      [l.user.id],
    );
    const res = await l.api.call('patch', url, { health: 'at_risk' }, { 'If-Match': '"1"' });
    expect(res.status).toBe(403);
    expect(await audits('status_update_edit', c.body.id)).toEqual([]);
    expect((await l.api.call('get', `/status-updates?region_id=${A}`)).status).toBe(200); // still reads
  });

  it('validates the shape of a new update', async () => {
    const l = await lead(null);
    const bad: unknown[] = [
      input({ region_id: undefined }), // a region update needs a region
      input({ team: 'cw' }), // a region update has no team
      { scope: 'team', health: 'on_track', summary: 'x' }, // a team update needs a team
      { scope: 'team', team: 'xx', health: 'on_track', summary: 'x' },
      input({ region_id: 8 }), input({ region_id: 0 }), input({ health: 'fine' }), input({ summary: '' }), input({ summary: '   ' }), input({ summary: 'x'.repeat(4001) }),
      input({ scope: 'planet' }), input({ author_id: l.user.id }), input({ week_start: '2026-01-04' }),
    ];
    for (const body of bad) expect((await l.api.call('post', '/status-updates', body)).status, JSON.stringify(body).slice(0, 70)).toBe(422);
    const ok = await l.api.call('post', '/status-updates', { scope: 'team', team: 'te', region_id: A, health: 'at_risk', summary: 'TE in region A.' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ scope: 'team', team: 'te', region_id: A });
  });
});

describe('X7 reading: regions, filters and pages', () => {
  it('shows an update only to readers of its region, plus the updates that cover all regions', async () => {
    const lA = await lead([A]);
    const lB = await lead([B]);
    const all = await lead(null);
    const cA = await lA.api.call('post', '/status-updates', input({ region_id: A }));
    const cB = await lB.api.call('post', '/status-updates', input({ region_id: B }));
    const cAll = await all.api.call('post', '/status-updates', { scope: 'team', team: 'cw', health: 'on_track', summary: 'All regions.' });
    const cTeamA = await lA.api.call('post', '/status-updates', { scope: 'team', team: 'te', region_id: A, health: 'on_track', summary: 'Team in A.' });
    expect([cA, cB, cAll, cTeamA].map((x) => x.status)).toEqual([201, 201, 201, 201]);
    const idsOf = async (who: Actor, q = ''): Promise<string[]> => ((await who.api.call('get', `/status-updates?limit=200${q}`)).body.items as { id: string }[]).map((i) => i.id);

    const readerA = await reader([A]);
    const seenA = await idsOf(readerA);
    expect(seenA).toEqual(expect.arrayContaining([cA.body.id, cAll.body.id, cTeamA.body.id]));
    expect(seenA).not.toContain(cB.body.id);
    const seenB = await idsOf(await reader([B]));
    expect(seenB).toContain(cB.body.id);
    expect(seenB).toContain(cAll.body.id);
    expect(seenB).not.toContain(cA.body.id);
    expect(seenB).not.toContain(cTeamA.body.id);
    // asking for a region the reader does not hold returns nothing of it (200, not an error that would tell it exists)
    expect(await idsOf(readerA, `&region_id=${B}`)).toEqual([]);
    const one = await readerA.api.call('get', `/status-updates?region_id=${A}&scope=team&team=te`);
    expect(one.body.items.map((i: { id: string }) => i.id)).toContain(cTeamA.body.id);
    expect(one.body.items.every((i: { scope: string; team: string }) => i.scope === 'team' && i.team === 'te')).toBe(true);
    // two regions at once
    const both = await idsOf(await reader([A, B]));
    expect(both).toEqual(expect.arrayContaining([cA.body.id, cB.body.id]));
    // an admin reads all
    const admin = await plainAdmin(app, db);
    expect(await idsOf(admin)).toEqual(expect.arrayContaining([cA.body.id, cB.body.id, cAll.body.id]));
  });

  it('pages newest week first with a cursor, filters by week, and refuses a bad filter or a forged cursor', async () => {
    const l = await lead();
    const weeks = ['2026-01-04', '2026-01-11', '2026-01-18', '2026-01-25'];
    const made: Record<string, string> = {};
    for (const w of weeks) made[w] = await old(l, w);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const res: request.Response = await l.api.call('get', `/status-updates?limit=2&region_id=${A}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...mine(res, l).map((x) => x.id));
      cursor = res.body.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([...weeks].reverse().map((w) => made[w]));
    const one = await l.api.call('get', '/status-updates?week_start=2026-01-11');
    expect(mine(one, l).map((x) => x.id)).toEqual([made['2026-01-11']]);
    expect(mine(one, l)[0]).toMatchObject({ week_end: '2026-01-17', editable: false });
    for (const q of ['week_start=2026-02-30', 'week_start=yesterday', 'scope=planet', 'team=xx', 'region_id=8', 'region_id=0', 'limit=0', 'limit=500']) {
      expect((await l.api.call('get', `/status-updates?${q}`)).status, q).toBe(422);
    }
    const forged = (parts: string[]) => Buffer.from(JSON.stringify(parts)).toString('base64url');
    for (const c of ['@@@', forged(['x', 'y', 'z']), forged(['2026-01-04', 'now', '00000000-0000-4000-8000-000000000000']), forged(['2026-01-04'])]) {
      expect((await l.api.call('get', `/status-updates?cursor=${encodeURIComponent(c)}`)).status, c).toBe(400);
    }
  });
});

describe('X7 nothing is removed', () => {
  it('has no delete in the interface, and the table refuses a delete or a truncate even from the owner', async () => {
    const l = await lead();
    const c = await l.api.call('post', '/status-updates', input());
    expect((await l.api.call('delete' as 'get', `/status-updates/${c.body.id}`)).status).toBe(404);
    await expect(db.query('DELETE FROM status_updates WHERE id = $1', [c.body.id])).rejects.toThrow(/never removed/);
    await expect(db.query('TRUNCATE status_updates')).rejects.toThrow(/never removed/);
    expect((await db.query('SELECT count(*)::int AS n FROM status_updates WHERE id = $1', [c.body.id])).rows[0].n).toBe(1);
  });
});
