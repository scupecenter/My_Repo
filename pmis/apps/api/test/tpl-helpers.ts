import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import type request from 'supertest';
import type { Api } from './helpers';
import { G, Team, team } from './reg-helpers';
import { addAssignment } from './wf-helpers';

/** Fixtures for the approved-template entry (migration 0037): a register team that may also use the Templates module. */

export const TPL_GRANTS_ENTRY = G('templates', 'view', 'import', 'download_documents');
export const TPL_GRANTS_VIEW = G('templates', 'view');

/** A register team (L1 entry, a reviewer, L2 approver) of one region whose members also hold the template grants. */
export async function tplTeam(app: NestExpressApplication, db: PgClient, key: string, module: string, region: number): Promise<Team> {
  const t = await team(app, db, key, module, region);
  await addAssignment(db, t.entry.user.id, { level: 'entry', regions: [region], modules: null, grants: TPL_GRANTS_ENTRY });
  await addAssignment(db, t.review.user.id, { level: 'review', regions: [region], modules: null, grants: TPL_GRANTS_VIEW });
  await addAssignment(db, t.approve.user.id, { level: 'approve', regions: [region], modules: null, grants: TPL_GRANTS_VIEW });
  return t;
}

/** GET a path and return the body as a Buffer (supertest buffers binary only when asked). */
export async function getBinary(api: Api, path: string): Promise<{ status: number; buffer: Buffer; headers: Record<string, string>; body: unknown }> {
  const res = await api.raw('get', path).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  const buffer = Buffer.isBuffer(res.body) ? (res.body as Buffer) : Buffer.alloc(0);
  let body: unknown = null;
  if (res.status >= 400) {
    try { body = JSON.parse(buffer.toString('utf8')); } catch { body = null; }
  }
  return { status: res.status, buffer, headers: res.headers as Record<string, string>, body };
}

export const downloadTemplate = (api: Api, id: string, query = ''): ReturnType<typeof getBinary> => getBinary(api, `/templates/${id}/download${query}`);

/** POST a file to /import-batches as multipart. */
export function uploadFile(api: Api, buffer: Buffer, fileName = 'upload.xlsx', fields: Record<string, string> = {}): request.Test {
  const t = api.raw('post', '/import-batches');
  if (api.csrf) t.set('X-CSRF-Token', api.csrf);
  for (const [k, v] of Object.entries(fields)) t.field(k, v);
  return t.attach('file', buffer, { filename: fileName, contentType: 'application/octet-stream' });
}

export async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

/** The value of one cell as plain text/number (a Date stays a Date). */
export const cellOf = (ws: ExcelJS.Worksheet, row: number, header: string): ExcelJS.CellValue => {
  const headers = ws.getRow(1);
  for (let c = 1; c <= headers.cellCount; c++) if (String(headers.getCell(c).value) === header) return ws.getRow(row).getCell(c).value;
  throw new Error(`no column ${header}`);
};

export type CellMap = Record<string, ExcelJS.CellValue>;

/** Writes rows (by header text) below the last used row of the Data sheet (or at `at`, 2-based) and returns the new file. A header not in the file throws. */
export async function fillTemplate(buffer: Buffer, rows: CellMap[], opts: { at?: number; sheet?: string; edit?: (wb: ExcelJS.Workbook) => void } = {}): Promise<Buffer> {
  const wb = await load(buffer);
  const ws = wb.getWorksheet(opts.sheet ?? 'Data');
  if (!ws) throw new Error('no Data sheet');
  const col = new Map<string, number>();
  const head = ws.getRow(1);
  for (let c = 1; c <= head.cellCount; c++) col.set(String(head.getCell(c).value), c);
  let r = opts.at ?? Math.max(2, lastDataRow(ws) + 1);
  for (const row of rows) {
    for (const [h, v] of Object.entries(row)) {
      const c = col.get(h);
      if (!c) throw new Error(`no column ${h}`);
      ws.getRow(r).getCell(c).value = v;
    }
    r += 1;
  }
  opts.edit?.(wb);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

export function lastDataRow(ws: ExcelJS.Worksheet): number {
  let last = 1;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    let any = false;
    row.eachCell({ includeEmpty: false }, () => { any = true; });
    if (any) last = n;
  });
  return last;
}

export const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
