import type { NestExpressApplication } from '@nestjs/platform-express';
import { zipSync } from 'fflate';
import type { Client as PgClient } from 'pg';
import type { Api } from './helpers';
import { Actor, Site, actor, makeSite, makeTask, setCell } from './wf-helpers';

/** Fixtures for the document suites. They run on the fifth database, where the seeded Document Library is active. */

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('....IHDR....fake png body')]);
export const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);
export const EML = Buffer.from('Received: from mail.example.test\r\nFrom: a@example.test\r\nTo: b@example.test\r\nSubject: PR approved\r\nDate: Mon, 02 Nov 2026 09:00:00 +0200\r\n\r\nBody\r\n');
export const SVG_SCRIPT = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
export const SVG_PLAIN = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');

export const zip = (files: Record<string, string>): Buffer => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(Buffer.from(v))]))));
export const XLSX = zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' });
export const XLSM = zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>', 'xl/vbaProject.bin': 'macro' });
export const ZIP_PATHS = zip({ '../evil.txt': 'x', 'a.txt': 'y' });

/** A JPEG with an EXIF block whose DateTimeOriginal is `date` (YYYY:MM:DD HH:MM:SS), or without EXIF when null. Big-endian TIFF. */
export function jpegWithExif(date: string | null): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const body = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]), Buffer.from('jpeg image data '.repeat(4))]);
  const eoi = Buffer.from([0xff, 0xd9]);
  if (date === null) return Buffer.concat([soi, body, eoi]);
  const txt = Buffer.from(date + '\0', 'latin1'); // 20 bytes
  // TIFF: header (8) | IFD0: count(2) + 1 entry(12) + next(4) = 18 -> ExifIFD at 26 | count(2) + entry(12) + next(4) = 18 -> string at 44
  const tiff = Buffer.alloc(8 + 18 + 18 + txt.length);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8769, 10);
  tiff.writeUInt16BE(4, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(26, 18);
  tiff.writeUInt32BE(0, 22);
  tiff.writeUInt16BE(1, 26);
  tiff.writeUInt16BE(0x9003, 28);
  tiff.writeUInt16BE(2, 30);
  tiff.writeUInt32BE(txt.length, 32);
  tiff.writeUInt32BE(44, 36);
  tiff.writeUInt32BE(0, 40);
  txt.copy(tiff, 44);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif]);
  return Buffer.concat([soi, app1, body, eoi]);
}

export const DOC_GRANTS: [string, string][] = [
  ['sites', 'view'], ['sites', 'edit'], ['sites', 'approve'], ['approvals', 'view'], ['approvals', 'approve'], ['sites.documents', 'download_documents'],
];

export interface DocFlow {
  site: Site;
  taskId: string;
  e: Actor;
  a: Actor;
}

/** A site with an open task of `code` (the trigger builds its slots from the published library), one L1 and one L2 holder. */
export async function docFlow(
  app: NestExpressApplication, db: PgClient, code = 'A2', o: { region?: number; state?: string; site?: Site; entry?: Actor; approve?: Actor } = {},
): Promise<DocFlow> {
  const region = o.region ?? 5;
  const e = o.entry ?? (await actor(app, db, { level: 'entry', regions: [region], grants: DOC_GRANTS }));
  const a = o.approve ?? (await actor(app, db, { level: 'approve', regions: [region], grants: DOC_GRANTS, stepUp: true }));
  const site = o.site ?? (await makeSite(db, region));
  const taskId = await makeTask(db, site, code, o.state ?? 'entry', { actualDate: '2026-01-05' });
  await setCell(db, code, region, 'entry', { user: [e.user.id] });
  await setCell(db, code, region, 'approve', { user: [a.user.id] });
  return { site, taskId, e, a };
}

export interface SlotView {
  id: string;
  doc_code: string;
  status: string;
  mandatory: boolean;
  files: { id: string; file_group_id: string; version: number; is_current: boolean; download_name: string; superseded_by: string | null; capture_date: string | null; unknown_capture_date: boolean; original_name: string; sha256: string; size_bytes: number }[];
  can_upload: boolean;
  [k: string]: unknown;
}

export async function slots(api: Api, taskId: string): Promise<SlotView[]> {
  const r = await api.call('get', `/tasks/${taskId}/slots`);
  if (r.status !== 200) throw new Error(`slots ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.items as SlotView[];
}

export const slotOf = async (api: Api, taskId: string, code: string, label: string | null = null): Promise<SlotView> => {
  const s = (await slots(api, taskId)).find((x) => x.doc_code === code && (x.candidate_label ?? null) === label);
  if (!s) throw new Error(`no slot ${code}`);
  return s;
};

export function upload(api: Api, taskId: string, slotId: string, buf: Buffer, name: string, extra: { replaces?: string; type?: string } = {}) {
  const t = api.call('post', `/tasks/${taskId}/slots/${slotId}/files`).attach('file', buf, { filename: name, contentType: extra.type ?? 'application/octet-stream' });
  if (extra.replaces) t.field('replaces_file_group_id', extra.replaces);
  return t;
}

export const submit = async (a: Actor, taskId: string) => {
  const t = (await a.api.call('get', `/tasks/${taskId}`)).body;
  return a.api.call('post', `/tasks/${taskId}/submit`, {}, { 'If-Match': `"${t.version}"` });
};
