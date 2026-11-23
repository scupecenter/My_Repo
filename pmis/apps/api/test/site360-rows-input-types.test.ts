import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellInput } from '../src/site360/site360.service';
import { startApp, superDb } from './helpers';
import { actor, makeSite, makeTask } from './wf-helpers';

/** Typed inline editors (0.15.48): each editable cell of GET /site360/{menu}/rows carries input_type, and list cells their options. */
const PREFIX = `S360T${randomBytes(3).toString('hex').toUpperCase()}`;
let app: NestExpressApplication;
let db: PgClient;
let dateMap: { task_code: string; ord: number };
let listMap: { task_code: string; ord: number; field_key: string; list_catalogue: string | null; options: string[] | null } | undefined;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  const inWorkflow = `EXISTS (SELECT 1 FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 WHERE td.code = tf.task_code)`;
  const d = await db.query(`SELECT tf.task_code, mc.ord FROM template_task_fields tf JOIN master_columns mc ON mc.letter = tf.master_col
    WHERE tf.field_key = 'actual_date' AND tf.is_active AND tf.scenarios IS NULL AND tf.projection IS NULL AND ${inWorkflow} ORDER BY mc.ord LIMIT 1`);
  dateMap = d.rows[0] as typeof dateMap;
  const l = await db.query(`SELECT tf.task_code, mc.ord, tf.field_key, tf.list_catalogue, tf.options FROM template_task_fields tf JOIN master_columns mc ON mc.letter = tf.master_col
    WHERE tf.field_type = 'list' AND tf.field_key LIKE 'v:%' AND tf.is_active AND tf.scenarios IS NULL AND tf.projection IS NULL AND ${inWorkflow} ORDER BY mc.ord LIMIT 1`);
  listMap = l.rows[0] as typeof listMap;
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('cellInput (the editor kind of a field)', () => {
  const opts = [{ value: 'A', label_en: 'Alpha', label_ar: null }];
  it('maps the template field types', () => {
    expect(cellInput('actual_date', 'text', null, undefined)).toEqual({ input_type: 'date' });
    expect(cellInput('v:x', 'date', null, undefined)).toEqual({ input_type: 'date' });
    expect(cellInput('v:x', 'number', null, undefined)).toEqual({ input_type: 'number' });
    expect(cellInput('v:x', 'yes_no', null, undefined)).toEqual({ input_type: 'boolean' });
    expect(cellInput('v:x', 'text', null, undefined)).toEqual({ input_type: 'text' });
  });
  it('a list takes the catalogue values, else its own options, else degrades to text', () => {
    expect(cellInput('v:x', 'list', ['Z'], opts)).toEqual({ input_type: 'list', options: opts });
    expect(cellInput('v:x', 'list', ['Z', 3], undefined)).toEqual({ input_type: 'list', options: [{ value: 'Z', label_en: 'Z', label_ar: null }] });
    expect(cellInput('v:x', 'list', null, undefined)).toEqual({ input_type: 'text' });
  });
});

describe('GET /site360/{menu}/rows: input_type and options', () => {
  it('a date cell says date and carries no options', async () => {
    const s = await makeSite(db, 1, { prefix: PREFIX });
    await makeTask(db, s, dateMap.task_code, 'open', { actualDate: '2026-03-10' });
    const a = await actor(app, db, { regions: [1] });
    const res = await a.api.call('get', `/site360/master/rows?site_code=${s.code}`);
    expect(res.status).toBe(200);
    const cell = res.body.rows[0].cells[String(dateMap.ord)];
    expect(cell.input_type).toBe('date');
    expect(cell.options).toBeUndefined();
  });

  it('a list cell carries its options (value and labels), the active values of its catalogue when it has one', async () => {
    if (!listMap) return; // no task list field is mapped to a Master column in this seed
    const s = await makeSite(db, 1, { prefix: PREFIX });
    await makeTask(db, s, listMap.task_code, 'open');
    const a = await actor(app, db, { regions: [1] });
    const res = await a.api.call('get', `/site360/master/rows?site_code=${s.code}`);
    expect(res.status).toBe(200);
    const cell = res.body.rows[0].cells[String(listMap.ord)];
    expect(cell.input_type).toBe('list');
    expect(cell.values).toBe(listMap.field_key.slice(2));
    expect(cell.options.length).toBeGreaterThan(0);
    for (const o of cell.options) expect(o).toEqual({ value: expect.any(String), label_en: expect.any(String), label_ar: expect.toSatisfy((x: unknown) => x === null || typeof x === 'string') });
    if (listMap.list_catalogue) {
      const lv = await db.query('SELECT code FROM list_values WHERE catalogue_code = $1 AND is_active ORDER BY sort_order, label_en', [listMap.list_catalogue]);
      expect(cell.options.map((o: { value: string }) => o.value)).toEqual(lv.rows.map((r: { code: string }) => r.code));
    } else {
      expect(cell.options.map((o: { value: string }) => o.value)).toEqual(listMap.options);
    }
  });
});
