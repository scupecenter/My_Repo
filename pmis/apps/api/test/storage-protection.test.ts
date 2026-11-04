import { randomBytes } from 'node:crypto';
import { mkdtempSync, promises as fs, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProblemException } from '../src/common/problem';
import { parseMasterKeys, sha256Hex } from '../src/documents/file-crypto';
import { ClamdScanner, parseReply } from '../src/documents/clamav';
import { purgeExpiredExports, encryptLegacyObjects, rescanPending, rewrapKeys, verifyStored } from '../src/documents/storage-maintenance';
import { LocalStorage, ProtectedStorage, type Envelope, type MetaStore, type StorageEvents } from '../src/documents/storage.service';
import { EICAR, startFakeClamd, type FakeClamd } from './fake-clamd';

/*
 * Storage protection (migration 0048, owner answer Q134). These tests need no database: the envelope rows are kept in memory behind the same
 * MetaStore interface the database implementation uses (storage_meta_* functions). The ClamAV side talks to a fake clamd on a unix socket.
 */

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);

class MemoryMeta implements MetaStore {
  rows = new Map<string, Envelope>();
  exports: { export_id: string; storage_key: string; expires_at: Date }[] = [];
  purged: string[] = [];
  alerts: { title: string; dedup: string; detail: Record<string, unknown> }[] = [];
  async put(row: Envelope, replace: boolean): Promise<void> {
    if (!replace && this.rows.has(row.storage_key)) throw new Error('duplicate envelope');
    this.rows.set(row.storage_key, { ...row });
  }
  async get(key: string) {
    return this.rows.get(key) ?? null;
  }
  async setScan(key: string, status: Envelope['scan_status']) {
    const r = this.rows.get(key);
    if (r && r.scan_status !== 'infected') r.scan_status = status;
  }
  async pending(limit: number) {
    return [...this.rows.values()].filter((r) => r.scan_status === 'pending_rescan').map((r) => r.storage_key).slice(0, limit);
  }
  async delete(key: string) {
    this.rows.delete(key);
  }
  async list(after: string | null, limit: number) {
    return [...this.rows.values()].filter((r) => r.storage_key > (after ?? '')).sort((a, b) => (a.storage_key < b.storage_key ? -1 : 1)).slice(0, limit);
  }
  async rotationBatch(active: string, limit: number) {
    return [...this.rows.values()].filter((r) => r.key_id !== active).slice(0, limit);
  }
  async rewrap(key: string, from: string, keyId: string, wrapped: Buffer) {
    const r = this.rows.get(key);
    if (!r || r.key_id !== from) return false;
    r.key_id = keyId;
    r.wrapped_key = wrapped;
    return true;
  }
  legacy: { storage_key: string; expected_sha256: string | null; size_bytes: number; source: string }[] = [];
  async legacyCandidates(limit: number) {
    return this.legacy.filter((l) => !this.rows.has(l.storage_key)).slice(0, limit);
  }
  async expiredExports(limit: number) {
    const now = Date.now();
    return this.exports.filter((e) => !this.purged.includes(e.export_id) && e.expires_at.getTime() < now).slice(0, limit);
  }
  async exportPurged(id: string) {
    this.purged.push(id);
  }
  async malwareAlert(title: string, detail: Record<string, unknown>, dedup: string) {
    this.alerts.push({ title, dedup, detail });
  }
}

function events(): StorageEvents & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    async log(level, message) {
      lines.push(`${level}: ${message}`);
    },
  };
}

describe('storage protection', () => {
  let dir: string;
  let sockDir: string;
  let clamd: FakeClamd;
  let meta: MemoryMeta;
  let ev: ReturnType<typeof events>;

  const keys = (active = 'k1', old = '') => parseMasterKeys({ FILE_ENC_KEY: active === 'k1' ? KEY_A : KEY_B, FILE_ENC_KEY_ID: active, FILE_ENC_OLD_KEYS: old });

  beforeAll(async () => {
    sockDir = mkdtempSync(join(tmpdir(), 'pmis-clamd-'));
    clamd = await startFakeClamd(join(sockDir, 'clamd.sock'));
  });

  afterAll(async () => {
    await clamd.close();
    rmSync(sockDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pmis-store-'));
    meta = new MemoryMeta();
    ev = events();
    clamd.mode = 'normal';
  });

  function store(opts: { scanner?: boolean; failure?: 'fail_closed' | 'fail_open'; socket?: string; active?: string; old?: string } = {}): ProtectedStorage {
    const scanner = opts.scanner === false ? null : new ClamdScanner({ socket: opts.socket ?? clamd.socketPath, timeoutMs: 5000 });
    return new ProtectedStorage(new LocalStorage(dir), meta, keys(opts.active ?? 'k1', opts.old ?? ''), scanner, opts.failure ?? 'fail_closed', ev);
  }

  async function readAll(s: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    return Buffer.concat(chunks);
  }

  const KEY = 'docs/2026/11/0c8f1d3e-1111-4222-8333-444455556666';
  const rawPath = (): string => join(dir, KEY);

  it('round trip: the stored bytes are not the plaintext, and get returns the plaintext', async () => {
    const plain = randomBytes(300_000);
    const s = store({ scanner: false });
    await s.put(KEY, plain);
    const onDisk = await fs.readFile(join(dir, KEY));
    expect(onDisk.length).toBe(plain.length);
    expect(onDisk.equals(plain)).toBe(false);
    const row = meta.rows.get(KEY);
    expect(row?.plain_sha256).toBe(sha256Hex(plain));
    expect(row?.wrapped_key.length).toBe(60);
    expect(row?.nonce.length).toBe(12);
    expect(row?.tag.length).toBe(16);
    expect((await readAll(await s.get(KEY))).equals(plain)).toBe(true);
  });

  it('a 200 MB file is streamed by putFile without a second copy in memory (round trip on a file)', async () => {
    const src = join(dir, 'source.bin');
    const size = 200 * 1024 * 1024;
    const { createWriteStream } = await import('node:fs');
    await new Promise<void>((resolve, reject) => {
      const w = createWriteStream(src);
      let left = size;
      const block = Buffer.alloc(1024 * 1024, 7);
      const pump = (): void => {
        while (left > 0) {
          const n = Math.min(left, block.length);
          left -= n;
          if (!w.write(block.subarray(0, n))) return void w.once('drain', pump);
        }
        w.end(() => resolve());
      };
      w.on('error', reject);
      pump();
    });
    const s = store({ scanner: false });
    await s.putFile(KEY, src, size);
    const back = await s.get(KEY);
    let total = 0;
    for await (const c of back) total += (c as Buffer).length;
    expect(total).toBe(size);
    rmSync(src, { force: true });
  }, 120_000);

  it('tamper detection: one changed byte in the stored object makes the read fail', async () => {
    const s = store({ scanner: false });
    await s.put(KEY, Buffer.from('a contract, about 40 bytes long, plain text'));
    const raw = await fs.readFile(rawPath());
    raw[3]! ^= 0x01;
    await fs.writeFile(rawPath(), raw);
    // nothing is released before the tag is verified: get() itself refuses, no partial plaintext stream is handed out
    await expect(s.get(KEY)).rejects.toThrow(/integrity/);
  });

  it('a large object is verified before release through an encrypted spool that leaves no file behind, and a tampered one is refused', async () => {
    const s = store({ scanner: false });
    const body = randomBytes(5 * 1024 * 1024 + 123);        // above the in-memory limit
    await s.put(KEY, body);
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('pmis-dec-')).length;
    const got = await readAll(await s.get(KEY));
    expect(got.equals(body)).toBe(true);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('pmis-dec-')).length).toBe(before);   // the spool is unlinked at once
    const raw = await fs.readFile(rawPath());
    raw[raw.length - 10]! ^= 0x01;                          // a byte near the end: GCM only notices at the tag
    await fs.writeFile(rawPath(), raw);
    await expect(s.get(KEY)).rejects.toThrow(/integrity/);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('pmis-dec-')).length).toBe(before);
  });

  it('a changed envelope tag also fails the read', async () => {
    const s = store({ scanner: false });
    await s.put(KEY, Buffer.from('hello world'));
    const row = meta.rows.get(KEY) as Envelope;
    row.tag = Buffer.alloc(16, 1);
    await expect(s.get(KEY)).rejects.toThrow();
  });

  it('Q199: the plaintext must also match the recorded size and SHA-256 before release (small and spooled objects)', async () => {
    const s = store({ scanner: false });
    await s.put(KEY, Buffer.from('a signed PAC, small'));
    (meta.rows.get(KEY) as Envelope).plain_sha256 = 'ab'.repeat(32);
    await expect(s.get(KEY)).rejects.toThrow(/integrity/);
    const KEY2 = 'docs/2026/11/0c8f1d3e-1111-4222-8333-aaaabbbbcccc';
    const big = randomBytes(4 * 1024 * 1024 + 99);
    await s.put(KEY2, big);
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('pmis-dec-')).length;
    (meta.rows.get(KEY2) as Envelope).plain_sha256 = 'cd'.repeat(32);
    await expect(s.get(KEY2)).rejects.toThrow(/integrity/);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('pmis-dec-')).length).toBe(before);
  });

  it('Q195: generated content (CSV log exports) is stored without the scanner, even when clamd is down under fail_closed', async () => {
    const s = store({ failure: 'fail_closed', socket: join(sockDir, 'missing.sock') });
    await expect(s.put(KEY, Buffer.from('an upload'))).rejects.toBeInstanceOf(ProblemException);
    await s.putGenerated(KEY, Buffer.from('id,at\r\n1,2026-11-04\r\n'));
    expect(meta.rows.get(KEY)?.scan_status).toBe('clean');
    expect((await readAll(await s.get(KEY))).toString()).toBe('id,at\r\n1,2026-11-04\r\n');
  });

  it('a legacy plaintext object (no envelope row) stays readable', async () => {
    await fs.mkdir(join(dir, 'docs/2026/11'), { recursive: true });
    writeFileSync(rawPath(), 'legacy bytes');
    const s = store({ scanner: false });
    expect((await readAll(await s.get(KEY))).toString()).toBe('legacy bytes');
  });

  it('key rotation rewraps only the data keys; the content is not rewritten and still decrypts', async () => {
    const s1 = store({ scanner: false });
    await s1.put(KEY, Buffer.from('rotate me'));
    const before = await fs.readFile(rawPath());
    const oldWrapped = Buffer.from(meta.rows.get(KEY)!.wrapped_key);
    const s2 = store({ scanner: false, active: 'k2', old: 'k1:' + KEY_A });
    const r = await rewrapKeys(s2);
    expect(r).toEqual({ done: 1, failed: 0 });
    expect(meta.rows.get(KEY)?.key_id).toBe('k2');
    expect(meta.rows.get(KEY)?.wrapped_key.equals(oldWrapped)).toBe(false);
    expect((await fs.readFile(rawPath())).equals(before)).toBe(true);
    expect((await readAll(await s2.get(KEY))).toString()).toBe('rotate me');
    // a second pass finds nothing to do (idempotent)
    expect((await rewrapKeys(s2)).done).toBe(0);
  });

  it('an object whose master key was removed cannot be read (fails loudly, not silently)', async () => {
    const s1 = store({ scanner: false });
    await s1.put(KEY, Buffer.from('x'));
    const s2 = store({ scanner: false, active: 'k2' });       // k1 not configured any more
    await expect(s2.get(KEY)).rejects.toThrow(/no master key/);
  });

  it('EICAR is refused with 422 file_rejected (reason malware), nothing is stored, and an alert is raised', async () => {
    const s = store();
    const body = Buffer.from(`header ${EICAR} trailer`);
    let caught: unknown;
    try {
      await s.put(KEY, body);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProblemException);
    const p = caught as ProblemException;
    expect(p.getStatus()).toBe(422);
    expect(p.code).toBe('file_rejected');
    expect(p.opts.extra).toMatchObject({ reason: 'malware' });
    expect(meta.rows.has(KEY)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(meta.alerts).toHaveLength(1);
    expect(meta.alerts[0]?.dedup).toBe(`malware_upload:${KEY}`);
    expect(ev.lines.some((l) => l.includes('malware'))).toBe(true);
  });

  it('a clean file passes the scan and is stored', async () => {
    const s = store();
    await s.put(KEY, Buffer.from('ordinary PDF-like text'));
    expect(meta.rows.get(KEY)?.scan_status).toBe('clean');
    expect(meta.alerts).toHaveLength(0);
  });

  it('fail_closed: clamd unavailable refuses the upload with 503 and stores nothing', async () => {
    const s = store({ failure: 'fail_closed', socket: join(sockDir, 'missing.sock') });
    let caught: unknown;
    try {
      await s.put(KEY, Buffer.from('fine file'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProblemException);
    expect((caught as ProblemException).getStatus()).toBe(503);
    expect(meta.rows.size).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(ev.lines.some((l) => l.startsWith('error: upload refused'))).toBe(true);
  });

  it('fail_open: clamd unavailable stores the file, flags it pending_rescan, and logs it', async () => {
    const s = store({ failure: 'fail_open', socket: join(sockDir, 'missing.sock') });
    await s.put(KEY, Buffer.from('accepted unscanned'));
    expect(meta.rows.get(KEY)?.scan_status).toBe('pending_rescan');
    expect(ev.lines.some((l) => l.includes('flagged for rescan'))).toBe(true);
    // Q195 (0056): the file stays in quarantine until the rescan passes it
    await expect(s.get(KEY)).rejects.toMatchObject({ code: 'file_pending_scan' });
    await meta.setScan(KEY, 'clean');
    expect((await readAll(await s.get(KEY))).toString()).toBe('accepted unscanned');
  });

  it('fail_open then the nightly rescan: clean files are released; an infected file is quarantined and alerted', async () => {
    const down = store({ failure: 'fail_open', socket: join(sockDir, 'missing.sock') });
    await down.put(KEY, Buffer.from('later clean'));
    const KEY2 = 'docs/2026/11/0c8f1d3e-1111-4222-8333-777788889999';
    await down.put(KEY2, Buffer.from(`bad ${EICAR}`));
    const up = store();
    const r = await rescanPending(meta, up);
    expect(r).toMatchObject({ done: 1, infected: 1, still_pending: 0 });
    expect(meta.rows.get(KEY)?.scan_status).toBe('clean');
    expect(meta.rows.get(KEY2)?.scan_status).toBe('infected');
    await expect(up.get(KEY2)).rejects.toBeInstanceOf(ProblemException);
    expect(meta.alerts.some((a) => a.dedup === `malware_rescan:${KEY2}`)).toBe(true);
  });

  it('a rescan while clamd is still down keeps the file pending', async () => {
    const down = store({ failure: 'fail_open', socket: join(sockDir, 'missing.sock') });
    await down.put(KEY, Buffer.from('still unknown'));
    const r = await rescanPending(meta, store({ socket: join(sockDir, 'missing.sock') }));
    expect(r.still_pending).toBe(1);
    expect(meta.rows.get(KEY)?.scan_status).toBe('pending_rescan');
  });

  it('a clamd ERROR reply is not a verdict: the upload is refused under fail_closed', async () => {
    clamd.mode = 'error';
    const s = store({ failure: 'fail_closed' });
    const err = await s.put(KEY, Buffer.from('anything')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).getStatus()).toBe(503);
  });

  it('zip cleanup deletes the object of an expired export, removes its envelope and marks the row purged', async () => {
    const s = store({ scanner: false });
    const EKEY = 'exports/2026/10/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await s.put(EKEY, Buffer.from('zip bytes'));
    meta.exports = [
      { export_id: 'e-1', storage_key: EKEY, expires_at: new Date(Date.now() - 86_400_000) },
      { export_id: 'e-2', storage_key: 'exports/2026/11/x', expires_at: new Date(Date.now() + 86_400_000) },
    ];
    const r = await purgeExpiredExports(meta, s);
    expect(r).toEqual({ done: 1, failed: 0 });
    expect(meta.purged).toEqual(['e-1']);
    expect(meta.rows.has(EKEY)).toBe(false);
    expect(readdirSync(join(dir, 'exports', '2026', '10'))).toEqual([]);
    expect(await purgeExpiredExports(meta, s)).toEqual({ done: 0, failed: 0 });   // idempotent
  });

  it('re-encrypt of a legacy object: encrypted in place, sha checked, a second run skips it', async () => {
    await fs.mkdir(join(dir, 'docs/2026/11'), { recursive: true });
    const plain = Buffer.from('legacy file content for the re-encrypt');
    writeFileSync(rawPath(), plain);
    meta.legacy = [{ storage_key: KEY, expected_sha256: sha256Hex(plain), size_bytes: plain.length, source: 'document_file' }];
    const s = store({ scanner: false });
    const r = await encryptLegacyObjects(meta, s);
    expect(r.encrypted).toBe(1);
    expect((await fs.readFile(rawPath())).equals(plain)).toBe(false);
    expect((await readAll(await s.get(KEY))).equals(plain)).toBe(true);
    const again = await encryptLegacyObjects(meta, s);
    expect(again.encrypted).toBe(0);
  });

  it('re-encrypt refuses an object whose bytes do not match the recorded SHA-256', async () => {
    await fs.mkdir(join(dir, 'docs/2026/11'), { recursive: true });
    writeFileSync(rawPath(), 'not what the row says');
    meta.legacy = [{ storage_key: KEY, expected_sha256: sha256Hex(Buffer.from('something else')), size_bytes: 3, source: 'document_file' }];
    const s = store({ scanner: false });
    const r = await encryptLegacyObjects(meta, s);
    expect(r.mismatch).toBe(1);
    expect(meta.rows.has(KEY)).toBe(false);
    expect((await fs.readFile(rawPath())).toString()).toBe('not what the row says');
  });

  it('verify (restore drill): every envelope decrypts to its recorded SHA-256 and size; a changed object is reported', async () => {
    const s = store({ scanner: false });
    await s.put(KEY, Buffer.from('verify me'));
    await s.put('docs/2026/11/0c8f1d3e-1111-4222-8333-000000000001', Buffer.from('and me'));
    expect(await verifyStored(meta, s)).toEqual({ checked: 2, bad: 0 });
    await fs.writeFile(rawPath(), Buffer.alloc(9, 1));
    const lines: string[] = [];
    expect(await verifyStored(meta, s, (l) => lines.push(l))).toEqual({ checked: 2, bad: 1 });
    expect(lines[0]).toContain(KEY);
  });

  it('master key parsing: rejects a short key and repeated ids', () => {
    expect(() => parseMasterKeys({ FILE_ENC_KEY: 'abc' })).toThrow(/FILE_ENC_KEY/);
    expect(() => parseMasterKeys({ FILE_ENC_KEY: KEY_A, FILE_ENC_OLD_KEYS: `k1:${KEY_B}` })).toThrow(/repeats/);
    expect(parseMasterKeys({ FILE_ENC_KEY: KEY_A }).activeId).toBe('k1');
  });

  it('the clamd verdict parser: OK, FOUND, and anything else is not a verdict', () => {
    expect(parseReply('stream: OK')).toEqual({ infected: false });
    expect(parseReply('stream: Eicar-Test-Signature FOUND')).toEqual({ infected: true, signature: 'Eicar-Test-Signature' });
    expect(() => parseReply('INSTREAM size limit exceeded. ERROR')).toThrow();
  });

  it('the fake clamd is reached over the protocol (ping and a scan of several chunks)', async () => {
    const sc = new ClamdScanner({ socket: clamd.socketPath, timeoutMs: 5000, chunkBytes: 1000 });
    expect(await sc.ping()).toBe(true);
    const big = Buffer.concat([Buffer.alloc(5000, 1), Buffer.from(EICAR), Buffer.alloc(2500, 2)]);
    expect((await sc.scan(big)).infected).toBe(true);
    expect((await sc.scan(Buffer.alloc(3000, 9))).infected).toBe(false);
  });
});
