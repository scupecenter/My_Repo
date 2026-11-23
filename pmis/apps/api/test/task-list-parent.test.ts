import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { Actor, actor, makeSite, makeTask, setCell } from './wf-helpers';

/**
 * Dependent lists on save (0.15.51): PATCH /tasks/{id} refuses a child list value whose parent value differs from the parent value the site holds
 * (422 list_parent_mismatch), accepts it while the parent is empty, and never refuses a cleared value. The parent field lives on task A2 and the child
 * field on task A1 of the same site (the parent may sit in another task). Synthetic list codes and field keys; the template fields are removed at the end.
 */
const REGION = 5;
const TAG = randomBytes(3).toString('hex');
const PARENT_LIST = `Zlpp${TAG}`;
const CHILD_LIST = `Zlpc${TAG}`;
const PARENT_KEY = `zlp_parent_${TAG}`;
const CHILD_KEY = `zlp_child_${TAG}`;
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  await db.query(
    `INSERT INTO list_catalogues (code, name_en, critical, status, allow_other) VALUES ($1, $1, false, 'confirmed', false)`,
    [PARENT_LIST],
  );
  await db.query(
    `INSERT INTO list_catalogues (code, name_en, critical, status, allow_other, parent_catalogue) VALUES ($1, $1, false, 'confirmed', false, $2)`,
    [CHILD_LIST, PARENT_LIST],
  );
  for (const [i, code] of ['P1', 'P2'].entries())
    await db.query(
      `INSERT INTO list_values (catalogue_code, code, label_en, sort_order) VALUES ($1, $2, $2, $3)`,
      [PARENT_LIST, code, i + 1],
    );
  for (const [i, [code, parent]] of [
    ['C1', 'P1'],
    ['C2', 'P2'],
  ].entries()) {
    await db.query(
      `INSERT INTO list_values (catalogue_code, code, label_en, sort_order, parent_value_id) VALUES ($1, $2, $2, $3, (SELECT id FROM list_values WHERE catalogue_code = $4 AND code = $5))`,
      [CHILD_LIST, code, i + 1, PARENT_LIST, parent],
    );
  }
  await db.query(
    `INSERT INTO template_task_fields (task_code, field_key, label, field_type, list_catalogue) VALUES ('A2', $1, 'Zlp parent', 'list', $2)`,
    [`v:${PARENT_KEY}`, PARENT_LIST],
  );
  await db.query(
    `INSERT INTO template_task_fields (task_code, field_key, label, field_type, list_catalogue) VALUES ('A1', $1, 'Zlp child', 'list', $2)`,
    [`v:${CHILD_KEY}`, CHILD_LIST],
  );
});
afterAll(async () => {
  await db.query(
    `DELETE FROM template_task_fields WHERE field_key = ANY($1::text[])`,
    [[`v:${PARENT_KEY}`, `v:${CHILD_KEY}`]],
  );
  await db.end();
  await app.close();
});

/** A site with the child task (A1, open, the actor holds L1) and the parent task (A2), the parent value stored as given. */
async function setup(
  parent: string | null,
): Promise<{ e: Actor; child: string; site: string }> {
  const e = await actor(app, db, { level: 'entry' });
  const site = await makeSite(db, REGION);
  const child = await makeTask(db, site, 'A1', 'open');
  const par = await makeTask(db, site, 'A2', 'open');
  await setCell(db, 'A1', REGION, 'entry', { user: [e.user.id] });
  if (parent)
    await db.query(
      `UPDATE task_instances SET values = jsonb_build_object($2::text, $3::text) WHERE id = $1`,
      [par, PARENT_KEY, parent],
    );
  return { e, child, site: site.id };
}
const save = (e: Actor, id: string, version: number, body: unknown) =>
  e.api.call('patch', `/tasks/${id}`, body, { 'If-Match': `'${version}'` });
const version = async (e: Actor, id: string) =>
  (await e.api.call('get', `/tasks/${id}`)).body.version as number;

describe('PATCH /tasks/{id}: dependent list values', () => {
  it('accepts a child value while the parent value of the site is empty', async () => {
    const { e, child } = await setup(null);
    const res = await save(e, child, await version(e, child), {
      values: { [CHILD_KEY]: 'C2' },
    });
    expect(res.status).toBe(200);
    expect(res.body.values[CHILD_KEY]).toBe('C2');
  });

  it('refuses a child value of another parent with 422 list_parent_mismatch, and saves nothing', async () => {
    const { e, child } = await setup('P1');
    const v = await version(e, child);
    const res = await save(e, child, v, { values: { [CHILD_KEY]: 'C2' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('list_parent_mismatch');
    expect(res.body.errors[0]).toMatchObject({
      path: `/values/${CHILD_KEY}`,
      code: 'list_parent_mismatch',
    });
    const after = (await e.api.call('get', `/tasks/${child}`)).body;
    expect(after.version).toBe(v);
    expect(after.values[CHILD_KEY]).toBeUndefined();
  });

  it('accepts a child value of the parent the site holds, and a cleared value', async () => {
    const { e, child } = await setup('P1');
    const ok = await save(e, child, await version(e, child), {
      values: { [CHILD_KEY]: 'C1' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.values[CHILD_KEY]).toBe('C1');
    const cleared = await save(e, child, ok.body.version, {
      values: { [CHILD_KEY]: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.values[CHILD_KEY]).toBeNull();
  });
});
