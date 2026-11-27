import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { Team, approveAll, createRec, post, recPath, team } from './reg-helpers';

/** Contract 0.15.226 (migration 0326): the Deliverables register is enabled, site-scoped, linked to a task and a gate of the workflow (Q71). */
let app: NestExpressApplication;
let db: PgClient;
let t: Team;
let taskCode: string;
let gateCode: string;

const OK = { deliverable_no: 'DLV-001', deliverable_kind: 'HLD', title: 'High level design', acceptance_ref: 'ACC-77' };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  t = await team(app, db, 'deliverables', 'deliverables', 5);
  taskCode = (await db.query(`SELECT code FROM task_definitions ORDER BY code LIMIT 1`)).rows[0].code;
  gateCode = (await db.query(`SELECT link_code FROM phase_gate_rules ORDER BY seq LIMIT 1`)).rows[0].link_code;
});
afterAll(async () => {
  await db.end();
});

describe('deliverables register', () => {
  it('is enabled and listed with its lists, its links and the template', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const res = await api.call('get', '/registers');
    expect(res.status).toBe(200);
    const def = (res.body.items as { register_key: string; approval_levels: number; site_scoped: boolean; fields: { code: string }[] }[]).find((r) => r.register_key === 'deliverables');
    expect(def?.approval_levels).toBe(2);
    expect(def?.site_scoped).toBe(true);
    expect(def?.fields.map((f) => f.code)).toEqual(expect.arrayContaining(['deliverable_no', 'deliverable_kind', 'task_code', 'gate_code', 'acceptance_ref', 'deliverable_state', 'submitted_date', 'accepted_date']));
    const lists = await db.query(`SELECT catalogue_code, count(*)::int AS n FROM list_values WHERE catalogue_code IN ('DeliverableState', 'DeliverableKind') GROUP BY 1 ORDER BY 1`);
    expect(lists.rows).toEqual([{ catalogue_code: 'DeliverableKind', n: 8 }, { catalogue_code: 'DeliverableState', n: 5 }]);
    expect((await db.query(`SELECT 1 FROM template_definitions WHERE template_id = 'TPL-DELIVERABLES' AND register_key = 'deliverables'`)).rowCount).toBe(1);
    // the data reset part exists since 0183 and no new table was added
    expect((await db.query(`SELECT 1 FROM data_reset_parts() WHERE code = 'deliverables'`)).rowCount).toBe(1);
  });

  it('checks the task and the gate it points at, and asks for the document before review', async () => {
    const badTask = await t.entry.api.call('post', recPath('deliverables'), { site_id: t.site.id, data: { ...OK, task_code: 'NOPE-TASK' } });
    expect(badTask.status, JSON.stringify(badTask.body)).toBe(422);
    expect(JSON.stringify(badTask.body)).toContain('unknown_task');
    const badGate = await t.entry.api.call('post', recPath('deliverables'), { site_id: t.site.id, data: { ...OK, gate_code: 'NOPE-GATE' } });
    expect(badGate.status).toBe(422);
    expect(JSON.stringify(badGate.body)).toContain('unknown_gate');
    const rec = await createRec(t, { ...OK, task_code: taskCode, gate_code: gateCode });
    expect(rec.state).toBe('entry');
    const noDoc = await post(t.entry.api, 'deliverables', rec.id, 'submit', rec.version);
    expect(noDoc.status, JSON.stringify(noDoc.body)).toBe(422);
    expect(JSON.stringify(noDoc.body)).toContain('document_required');
    // the document is a file reference (uploaded through the files endpoint); set directly here
    await db.query(`UPDATE register_records SET data = data || '{"deliverable_file": "doc-1"}'::jsonb WHERE id = $1`, [rec.id]);
    const cur = await t.entry.api.call('get', recPath('deliverables', rec.id));
    const done = await approveAll(t, rec.id, cur.body.version ?? rec.version);
    expect(done.state).toBe('approved');
  });
});
