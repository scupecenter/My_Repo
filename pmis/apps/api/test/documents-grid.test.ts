import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocsGridService } from '../src/documents/grid.service';
import { startApp, superDbDocs, type Api } from './helpers';
import { plainAdmin } from './wf-helpers';

/** Documents hub (0097): the grid's cell rules, the grid endpoint, the saved columns, and the Library delete rule for a type with no file. Runs on the fifth database. */
const col = (over: Partial<Parameters<typeof DocsGridService.cellOf>[0]['column']> = {}) => ({
  id: 'x', code: 'A2', name_en: 'A2', name_ar: null, kind: 'scanned_document', form_kind: null,
  placements: [{ kind: 'task' as const, task: 'A2', stage: 'MS1', register: null }], ...over,
});
const cell = (c: ReturnType<typeof col>, o: Partial<Parameters<typeof DocsGridService.cellOf>[0]> = {}) =>
  DocsGridService.cellOf({ column: c, taskStates: new Map([['A2', 'open']]), slots: undefined, files: undefined, override: undefined, ...o });

describe('grid cell status (pure rules)', () => {
  it('marks an overridden site cell not required with its reason', () => {
    expect(cell(col(), { override: 'Not needed here' })).toMatchObject({ status: 'not_required', reason: 'Not needed here' });
  });
  it('reports approved, expired, rejected and pending from the slot counts', () => {
    const agg = (x: Partial<{ slots: number; approved: number; expired: number; rejected: number; pending: number; not_required: number }>) =>
      ({ slots: 1, approved: 0, expired: 0, rejected: 0, pending: 0, not_required: 0, ...x });
    expect(cell(col(), { slots: agg({ approved: 1 }) }).status).toBe('approved');
    expect(cell(col(), { slots: agg({ expired: 1 }) }).status).toBe('expired');
    expect(cell(col(), { slots: agg({ rejected: 1 }) }).status).toBe('rejected');
    expect(cell(col(), { slots: agg({ pending: 1 }) }).status).toBe('pending');
    expect(cell(col(), { slots: agg({ not_required: 1 }) }).status).toBe('not_required');
  });
  it('shows missing when the task is open and no slot exists yet', () => {
    expect(cell(col()).status).toBe('missing');
  });
  it('not applicable when the site has no instance of the placed task', () => {
    expect(cell(col(), { taskStates: new Map() }).status).toBe('not_applicable');
  });
  it('generated forms are generatable when the task is open and blocked with the state otherwise', () => {
    const form = col({ form_kind: 'dn', kind: 'generated_form' });
    expect(cell(form).status).toBe('generatable');
    expect(cell(form, { taskStates: new Map([['A2', 'locked']]) })).toMatchObject({ status: 'blocked', reason: 'Task A2 is locked' });
  });
});

let app: NestExpressApplication;
let db: PgClient;
let admin: Api;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DOCS as string });
  db = await superDbDocs();
  admin = (await plainAdmin(app, db, true)).api;
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('the grid endpoint', () => {
  it('lists the seeded columns and rows with statuses from the contract set', async () => {
    const r = await admin.call('get', '/documents/grid?limit=5');
    expect(r.status).toBe(200);
    expect(r.body.columns.length).toBeGreaterThan(0);
    expect(r.body.rows.length).toBeLessThanOrEqual(5);
    const allowed = ['missing', 'pending', 'approved', 'expired', 'rejected', 'not_required', 'generatable', 'blocked', 'not_applicable'];
    for (const row of r.body.rows as { cells: Record<string, { status: string }> }[]) {
      for (const c of Object.values(row.cells)) expect(allowed).toContain(c.status);
    }
  });

  it('rejects an unknown status filter', async () => {
    const r = await admin.call('get', '/documents/grid?status=nope');
    expect(r.status).toBe(422);
  });

  it('saves and returns the caller\'s grid columns', async () => {
    const put = await admin.call('put', '/documents/grid/view', { columns: ['A2', 'B1'] });
    expect(put.status).toBe(204);
    const got = await admin.call('get', '/documents/grid/view');
    expect(got.body).toEqual({ columns: ['A2', 'B1'] });
  });

  it('deletes a Library type that never had a file', async () => {
    const c = await admin.call('post', '/document-library', { code: 'HUB_TEST_DEL', kind: 'scanned_document', name_en: 'Hub delete test', placements: [{ target: 'task', ref: 'A2' }], reason: 'test' });
    expect(c.status).toBe(201);
    const d = await admin.call('post', `/document-library/${c.body.id}/delete`, { reason: 'test cleanup' });
    expect(d.status).toBe(200);
    expect(d.body.mode).toBe('deleted');
  });
});
