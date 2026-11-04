import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config';
import { readExifDate } from '../src/documents/exif';
import { attachmentHeader, displayName, safePart } from '../src/documents/naming';
import { evalRule } from '../src/documents/rules';
import { canonicalExt, formatAllowed, sniff } from '../src/documents/sniff';
import { LocalStorage, S3Storage, newObjectKey, storageFor } from '../src/documents/storage.service';
import { suggestSlots } from '../src/documents/suggest';
import { EML, EXE, PDF, PNG, SVG_PLAIN, SVG_SCRIPT, XLSM, XLSX, ZIP_PATHS, jpegWithExif, zip } from './doc-helpers';

/** The pure parts of the document module: magic bytes, EXIF, rules, names, suggestions, the two storage drivers and their configuration. */

describe('content type by magic bytes', () => {
  const type = (b: Buffer, name = 'x') => {
    const r = sniff(b, name);
    return r.ok ? r.ext : `rejected:${r.reason}`;
  };
  it.each([
    ['a PDF', PDF, 'pdf'], ['a PNG', PNG, 'png'], ['a JPEG', jpegWithExif(null), 'jpg'], ['an e-mail', EML, 'eml'], ['a workbook', XLSX, 'xlsx'],
    ['a plain SVG', SVG_PLAIN, 'svg'], ['a HEIC photo', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic....')]), 'heic'],
    ['a PDF with junk before the header', Buffer.concat([Buffer.from('junk\n'), PDF]), 'pdf'],
    ['a docx', zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w/>' }), 'docx'],
  ])('knows %s', (_n, b, ext) => expect(type(b)).toBe(ext));

  it.each([
    ['a Windows program', EXE, 'rejected:executable'], ['a Linux program', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(40)]), 'rejected:executable'],
    ['a shell script', Buffer.from('#!/bin/sh\nrm -rf /\n'), 'rejected:executable'], ['an empty file', Buffer.alloc(0), 'rejected:empty'],
    ['a zip that is not an office file', zip({ 'a.txt': 'x' }), 'rejected:archive'], ['a zip with paths', ZIP_PATHS, 'rejected:archive'],
    ['a gzip', Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]), 'rejected:archive'], ['a rar', Buffer.from('Rar!\x1a\x07\x00....'), 'rejected:archive'],
    ['a macro workbook', XLSM, 'rejected:macro'], ['an SVG with a script', SVG_SCRIPT, 'rejected:script'],
    ['an SVG with an event handler', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>'), 'rejected:script'],
    ['a web page', Buffer.from('<html><body>x</body></html>'), 'rejected:html'], ['binary noise', Buffer.from([1, 2, 3, 0, 4, 5]), 'rejected:unknown_type'],
    ['an old Office file', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'rejected:macro'],
  ])('rejects %s', (_n, b, expected) => expect(type(b)).toBe(expected));

  it('accepts an Outlook message only under the .msg name', () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(type(ole, 'mail.msg')).toBe('msg');
    expect(type(ole, 'mail.doc')).toBe('rejected:macro');
  });

  it('judges the format list by the sniffed type, jpeg and jpg being one', () => {
    const jpg = sniff(jpegWithExif(null));
    if (!jpg.ok) throw new Error('jpeg');
    expect(formatAllowed(jpg, ['pdf', 'jpeg'])).toBe(true);
    expect(formatAllowed(jpg, ['pdf', 'png'])).toBe(false);
    expect(canonicalExt('.JPEG')).toBe('jpg');
  });
});

describe('EXIF capture date', () => {
  it('reads DateTimeOriginal from a JPEG', () => expect(readExifDate(jpegWithExif('2026:03:04 10:20:30'))?.toISOString()).toBe('2026-03-04T10:20:30.000Z'));
  it('answers null without EXIF, with a damaged block, or with an impossible date', () => {
    expect(readExifDate(jpegWithExif(null))).toBeNull();
    expect(readExifDate(jpegWithExif('2026:13:45 99:99:99'))).toBeNull();
    const damaged = jpegWithExif('2026:03:04 10:20:30').subarray(0, 40);
    expect(readExifDate(damaged)).toBeNull();
    expect(readExifDate(PNG)).toBeNull();
    expect(readExifDate(Buffer.alloc(0))).toBeNull();
  });
});

describe('the rule language', () => {
  const ctx = { site: { scope_tower_erection: 'yes', custom: { near_airport: 'no' }, tower_height_m: 30 }, task: { values: { analysis_type: 'STA' } }, scenario: 'new_build' };
  it('evaluates', () => {
    expect(evalRule(null, ctx)).toBe(true);
    expect(evalRule({ is_yes: 'site.scope_tower_erection' }, ctx)).toBe(true);
    expect(evalRule({ is_yes: 'site.custom.near_airport' }, ctx)).toBe(false);
    expect(evalRule({ in: ['task.values.analysis_type', ['STA', 'ST']] }, ctx)).toBe(true);
    expect(evalRule({ eq: ['scenario', 'hot_swap'] }, ctx)).toBe(false);
    expect(evalRule({ all: [{ is_yes: 'site.scope_tower_erection' }, { not: { is_yes: 'site.custom.near_airport' } }] }, ctx)).toBe(true);
    expect(evalRule({ any: [{ eq: ['scenario', 'hot_swap'] }, { eq: ['scenario', 'new_build'] }] }, ctx)).toBe(true);
    expect(evalRule({ is_na: 'site.custom.missing' }, ctx)).toBe(true);
  });
  it('answers null when it cannot judge, and never throws', () => {
    expect(evalRule({ is_yes: 'site.custom.unknown' }, ctx)).toBeNull();
    expect(evalRule({ eq: ['procurement.delivery', 'outsourced'] }, ctx)).toBeNull();
    expect(evalRule({ count: { x: 1 } }, ctx)).toBeNull();
    expect(evalRule({ all: [{ is_yes: 'site.custom.unknown' }, { eq: ['scenario', 'hot_swap'] }] }, ctx)).toBe(false);
    expect(evalRule({ any: [{ is_yes: 'site.custom.unknown' }, { eq: ['scenario', 'hot_swap'] }] }, ctx)).toBeNull();
    expect(evalRule({ a: 1, b: 2 }, ctx)).toBeNull();
    expect(evalRule('x', ctx)).toBeNull();
    expect(evalRule({ is_yes: 'constructor.prototype' }, ctx)).toBeNull();
  });
});

describe('file names', () => {
  const base = { site_code: 'TRP-0012', task_code: 'A2', doc_code: 'A2', approved_date: '2026-11-02', uploaded_at: new Date('2026-10-30T10:00:00Z'), ext: 'pdf', version: 1, is_current: true };
  it('is SITE_TASK_DOC_APPROVEDDATE.ext', () => expect(displayName(base)).toBe('TRP-0012_A2_A2_20261102.pdf'));
  it('uses DRAFT and the upload date before approval, _v<n> for a superseded version, and a number for the second file', () => {
    expect(displayName({ ...base, approved_date: null })).toBe('TRP-0012_A2_A2_DRAFT-20261030.pdf');
    expect(displayName({ ...base, is_current: false, version: 2 })).toBe('TRP-0012_A2_A2_20261102_v2.pdf');
    expect(displayName({ ...base, ordinal: 2 })).toBe('TRP-0012_A2_A2_20261102_2.pdf');
    expect(displayName({ ...base, candidate_label: 'Candidate 2' })).toBe('TRP-0012_A2_A2_Candidate-2_20261102.pdf');
  });
  it('is safe whatever the codes hold', () => {
    const n = displayName({ ...base, site_code: '../../etc/passwd', doc_code: 'a"b\r\nc', ext: 'p/d?f' });
    expect(n).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(safePart('')).toBe('X');
    expect(attachmentHeader('a b"c\r\n.pdf')).toBe('attachment; filename="a_b_c__.pdf"');
    expect(attachmentHeader('x.pdf')).toMatch(/^attachment; /);
  });
});

describe('suggestions from file names', () => {
  const slots = [
    { slot_id: 's1', doc_code: 'A2', name_en: 'A2 TSSR', name_ar: null },
    { slot_id: 's2', doc_code: 'B7', name_en: 'B7 Layout approval email', name_ar: null },
    { slot_id: 's3', doc_code: 'B7_DN', name_en: 'B7 CW DN (signed scan)', name_ar: null },
    { slot_id: 's4', doc_code: 'A3', name_en: 'A3 Owner contract (or contract with the tower owner)', name_ar: null },
  ];
  it('prefers the code, then the words of the name, and says nothing when nothing matches', () => {
    expect(suggestSlots('TSSR_final_v3.pdf', slots)[0]?.doc_code).toBe('A2');
    expect(suggestSlots('A3-owner-contract.pdf', slots)[0]?.doc_code).toBe('A3');
    expect(suggestSlots('B7_DN_signed.pdf', slots)[0]?.doc_code).toBe('B7_DN');
    expect(suggestSlots('layout approval email.eml', slots)[0]?.doc_code).toBe('B7');
    expect(suggestSlots('holiday photo.png', slots)).toEqual([]);
  });
});

describe('storage drivers', () => {
  it('keeps files on local disk under random keys and refuses keys that leave the directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pmis-local-'));
    const s = new LocalStorage(dir);
    const key = newObjectKey('docs');
    expect(key).toMatch(/^docs\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    await s.put(key, Buffer.from('hello'));
    const chunks: Buffer[] = [];
    for await (const c of await s.get(key)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    await expect(s.put(key, Buffer.from('again'))).rejects.toThrow(); // never overwritten
    await s.remove(key);
    await expect(s.get(key)).rejects.toThrow();
    for (const bad of ['../x/y', '/etc/passwd', 'docs/../../x', 'docs/a b/c', 'DOCS/2026/11/x']) await expect(s.put(bad, Buffer.from('x'))).rejects.toThrow('invalid storage key');
    expect(readdirSync(dir).includes('x')).toBe(false);
  });

  it('talks to an S3-compatible server (path style) through the AWS SDK v3 client', async () => {
    const store = new Map<string, Buffer>();
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url}`);
        const key = (req.url ?? '').split('?')[0]!;
        if (req.method === 'PUT') {
          store.set(key, Buffer.concat(chunks));
          res.writeHead(200, { ETag: '"x"' }).end();
        } else if (req.method === 'GET') {
          const v = store.get(key);
          if (!v) res.writeHead(404, { 'Content-Type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
          else res.writeHead(200, { 'Content-Length': v.length }).end(v);
        } else if (req.method === 'DELETE') {
          store.delete(key);
          res.writeHead(204).end();
        } else res.writeHead(405).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const s = new S3Storage({ endpoint: `http://127.0.0.1:${port}`, bucket: 'pmis-docs', accessKey: 'AK', secretKey: 'SK', region: 'us-east-1' });
      const key = newObjectKey('docs');
      await s.put(key, Buffer.from('payload'));
      expect(seen[0]).toBe(`PUT /pmis-docs/${key}?x-id=PutObject`);
      const chunks: Buffer[] = [];
      for await (const c of await s.get(key)) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe('payload');
      await s.remove(key);
      await expect(s.get(key)).rejects.toThrow();
      await expect(s.put('../bad/key', Buffer.from('x'))).rejects.toThrow('invalid storage key');
    } finally {
      server.close();
    }
  });
});

describe('storage configuration', () => {
  const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://x', LOG_HMAC_KEY: '0123456789abcdef0123', TOTP_ENC_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', FILE_ENC_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', PMIS_CONTEXT_KEY: 'd'.repeat(64) };
  it('uses local disk unless S3 is fully configured', () => {
    expect(loadConfig(env).storage).toMatchObject({ driver: 'local', localDir: './storage' });
    expect(loadConfig({ ...env, STORAGE_DIR: '/var/lib/pmis/files' }).storage).toMatchObject({ driver: 'local', localDir: '/var/lib/pmis/files' });
    const s3 = { S3_ENDPOINT: 'http://127.0.0.1:9000', S3_BUCKET: 'pmis', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b', S3_REGION: 'eu-west-1' };
    expect(loadConfig({ ...env, ...s3 }).storage).toMatchObject({ driver: 's3', s3: { endpoint: 'http://127.0.0.1:9000', bucket: 'pmis', region: 'eu-west-1' } });
    expect(storageFor(loadConfig({ ...env, ...s3 }).storage).driver).toBe('s3');
    expect(storageFor(loadConfig(env).storage).driver).toBe('local');
  });
  it('refuses a half-set S3 configuration', () => {
    expect(() => loadConfig({ ...env, S3_ENDPOINT: 'http://127.0.0.1:9000', S3_BUCKET: 'pmis' })).toThrow(/S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY/);
  });
});
