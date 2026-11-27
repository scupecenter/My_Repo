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
    // the document is a file of a document slot of the record (planted by the migration role, as the Meetings test does)
    const U = Date.now().toString(36);
    const dt = await db.query(`INSERT INTO document_types (code, name_en, updated_at) VALUES ($1, 'Deliverable', now()) RETURNING id`, [`DLV${U}`]);
    const slot = await db.query(`INSERT INTO document_slots (site_id, region_id, doc_type_id, status, register_entity_id, register_key) VALUES ($1, $2, $3, 'uploaded', $4, 'deliverables') RETURNING id`,
      [t.site.id, (await db.query(`SELECT region_id FROM sites WHERE id = $1`, [t.site.id])).rows[0].region_id, dt.rows[0].id, rec.entity_id]);
    const file = await db.query(`INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, size_bytes, sha256, uploaded_by)
      VALUES ($1, gen_random_uuid(), 'deliverable.pdf', 'deliverable.pdf', $2, 'application/pdf', 10, 'x', $3) RETURNING id`, [slot.rows[0].id, `dlv/${U}`, t.entry.user.id]);
    await db.query(`UPDATE register_records SET data = data || jsonb_build_object('deliverable_file', $2::text) WHERE id = $1`, [rec.id, file.rows[0].id]);
    const cur = await t.entry.api.call('get', recPath('deliverables', rec.id));
    const done = await approveAll(t, rec.id, cur.body.version ?? rec.version);
    expect(done.state).toBe('approved');
  });
});
