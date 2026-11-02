import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_CONFIG, AppConfig, ScanConfig } from '../config/config';
import { ProblemException } from '../common/problem';
import { SyslogService } from '../auth/syslog.service';
import { DbService } from '../db/db.service';
import { ClamdScanner, ScannerUnavailable, type Scanner } from './clamav';
import { GcmEncryptor, MasterKeys, Sha256Tap, gcmDecryptStream, newDataKey, sha256Hex, unwrapDataKey, wrapDataKey } from './file-crypto';

/**
 * Object storage for documents, blank forms and zip exports (ADR 0008).
 *
 * `StorageService.store` keeps the methods the documents module has always used: put(key, buffer), putFile(key, path, size), get(key)
 * and remove(key). Since migration 0048 the store also (a) encrypts every object with AES-256-GCM under a random data key (file-crypto.ts),
 * streaming, (b) scans every put() with clamd before anything is stored (SCAN_FAILURE decides what happens when clamd is down) and (c)
 * reads a legacy plaintext object (no envelope row) as it is. A put() that the scanner refuses throws 422 file_rejected, reason malware.
 */

/** The things the documents module needs from object storage. Keys are opaque and random; nothing in a key comes from a user. */
export interface ObjectStorage {
  readonly driver: 's3' | 'local';
  put(key: string, body: Buffer): Promise<void>;
  putFile(key: string, path: string, size: number): Promise<void>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  /** Writes a stream of known length. `replace` overwrites an existing object (only the re-encrypt maintenance uses it). */
  putStream(key: string, body: Readable, size: number, replace?: boolean): Promise<void>;
}

const KEY_RE = /^[a-z0-9]+(\/[a-z0-9-]+)+$/;

function checkKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..')) throw new Error('invalid storage key');
}

/** Files on local disk (small installs, tests). Created with mode 0600 inside the configured directory, never overwritten unless asked. */
export class LocalStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  private readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private path(key: string): string {
    checkKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer): Promise<void> {
    const p = this.path(key);
    await fs.mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await fs.writeFile(p, body, { flag: 'wx', mode: 0o600 });
  }
  async putFile(key: string, path: string): Promise<void> {
    await this.putStream(key, createReadStream(path), 0);
  }
  async putStream(key: string, body: Readable, _size: number, replace = false): Promise<void> {
    const p = this.path(key);
    await fs.mkdir(dirname(p), { recursive: true, mode: 0o700 });
    if (!replace) {
      await pipeline(body, createWriteStream(p, { flags: 'wx', mode: 0o600 }));
      return;
    }
    const tmp = `${p}.tmp-${randomUUID()}`;
    await pipeline(body, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    await fs.rename(tmp, p);                               // atomic on the same file system
  }
  async get(key: string): Promise<Readable> {
    const p = this.path(key);
    await fs.access(p);
    return createReadStream(p);
  }
  async remove(key: string): Promise<void> {
    await fs.rm(this.path(key), { force: true });
  }
}

/** S3-compatible storage (MinIO on-prem) through the AWS SDK v3 client. Path-style addressing, as MinIO expects. */
export class S3Storage implements ObjectStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  constructor(private readonly cfg: NonNullable<AppConfig['storage']['s3']>) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      // MinIO and other S3-compatible servers do not all accept the newer default checksum trailers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  async put(key: string, body: Buffer): Promise<void> {
    checkKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentLength: body.length, ContentType: 'application/octet-stream' }));
  }
  async putFile(key: string, path: string, size: number): Promise<void> {
    await this.putStream(key, createReadStream(path), size);
  }
  async putStream(key: string, body: Readable, size: number): Promise<void> {
    checkKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentLength: size, ContentType: 'application/octet-stream' }));
  }
  async get(key: string): Promise<Readable> {
    checkKey(key);
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    if (!r.Body) throw new Error('empty object');
    return r.Body as Readable;
  }
  async remove(key: string): Promise<void> {
    checkKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

export function storageFor(cfg: AppConfig['storage']): ObjectStorage {
  return cfg.driver === 's3' && cfg.s3 ? new S3Storage(cfg.s3) : new LocalStorage(cfg.localDir);
}

/** Random object key under a prefix: `docs/2026/11/<uuid>`. Never derived from a file name. */
export function newObjectKey(prefix: 'docs' | 'forms' | 'exports', now: Date = new Date()): string {
  return `${prefix}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
}

/** The envelope row of an encrypted object (stored_object_meta). Binary fields are Buffers. */
export interface Envelope {
  storage_key: string;
  driver: 'local' | 's3';
  key_id: string;
  wrapped_key: Buffer;
  nonce: Buffer;
  tag: Buffer;
  plain_sha256: string;
  size_bytes: number;
  scan_status: 'clean' | 'pending_rescan' | 'infected';
}

/** Where envelopes live. The database implementation calls the storage_* functions (migration 0048); tests use an in-memory one. */
export interface MetaStore {
  put(row: Envelope, replace: boolean): Promise<void>;
  get(key: string): Promise<Envelope | null>;
  setScan(key: string, status: 'clean' | 'infected' | 'pending_rescan'): Promise<void>;
  pending(limit: number): Promise<string[]>;
  delete(key: string): Promise<void>;
  list(after: string | null, limit: number): Promise<Envelope[]>;
  rotationBatch(activeKeyId: string, limit: number): Promise<Envelope[]>;
  rewrap(key: string, fromKeyId: string, keyId: string, wrapped: Buffer): Promise<boolean>;
  legacyCandidates(limit: number): Promise<{ storage_key: string; expected_sha256: string | null; size_bytes: number; source: string }[]>;
  expiredExports(limit: number): Promise<{ export_id: string; storage_key: string; expires_at: Date }[]>;
  exportPurged(exportId: string): Promise<void>;
  malwareAlert(title: string, detail: Record<string, unknown>, dedup: string): Promise<void>;
}

/** What the storage layer tells the System Log and the security alerts. */
export interface StorageEvents {
  log(level: 'info' | 'warn' | 'error', message: string, context: Record<string, unknown>): Promise<void>;
}

export class DbMetaStore implements MetaStore {
  constructor(private readonly db: DbService) {}

  private toEnvelope(r: Record<string, unknown>): Envelope {
    return {
      storage_key: String(r.storage_key), driver: r.driver as 'local' | 's3', key_id: String(r.key_id),
      wrapped_key: Buffer.from(r.wrapped_key as Uint8Array), nonce: Buffer.from(r.nonce as Uint8Array), tag: Buffer.from(r.tag as Uint8Array),
      plain_sha256: String(r.plain_sha256), size_bytes: Number(r.size_bytes), scan_status: r.scan_status as Envelope['scan_status'],
    };
  }

  async put(row: Envelope, replace: boolean): Promise<void> {
    await this.db.client.$executeRaw(Prisma.sql`SELECT storage_meta_put(${row.storage_key}::text, ${row.driver}::text, ${row.key_id}::text,
      ${row.wrapped_key}::bytea, ${row.nonce}::bytea, ${row.tag}::bytea, ${row.plain_sha256}::text, ${row.size_bytes}::bigint,
      ${row.scan_status}::text, ${replace}::boolean)`);
  }
  async get(key: string): Promise<Envelope | null> {
    const rows = await this.db.client.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT * FROM storage_meta_get(${key}::text)`);
    return rows[0] ? this.toEnvelope(rows[0]) : null;
  }
  async setScan(key: string, status: 'clean' | 'infected' | 'pending_rescan'): Promise<void> {
    await this.db.client.$executeRaw(Prisma.sql`SELECT storage_meta_set_scan(${key}::text, ${status}::text)`);
  }
  async pending(limit: number): Promise<string[]> {
    const rows = await this.db.client.$queryRaw<{ storage_meta_pending: string }[]>(Prisma.sql`SELECT storage_meta_pending(${limit}::int)`);
    return rows.map((r) => r.storage_meta_pending);
  }
  async delete(key: string): Promise<void> {
    await this.db.client.$executeRaw(Prisma.sql`SELECT storage_meta_delete(${key}::text)`);
  }
  async list(after: string | null, limit: number): Promise<Envelope[]> {
    const rows = await this.db.client.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT * FROM storage_meta_list(${after}::text, ${limit}::int)`);
    return rows.map((r) => this.toEnvelope(r));
  }
  async rotationBatch(activeKeyId: string, limit: number): Promise<Envelope[]> {
    const rows = await this.db.client.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT * FROM storage_meta_rotation_batch(${activeKeyId}::text, ${limit}::int)`);
    return rows.map((r) => this.toEnvelope(r));
  }
  async rewrap(key: string, fromKeyId: string, keyId: string, wrapped: Buffer): Promise<boolean> {
    const rows = await this.db.client.$queryRaw<{ storage_meta_rewrap: boolean }[]>(Prisma.sql`SELECT storage_meta_rewrap(${key}::text, ${fromKeyId}::text, ${keyId}::text, ${wrapped}::bytea)`);
    return rows[0]?.storage_meta_rewrap === true;
  }
  async legacyCandidates(limit: number): Promise<{ storage_key: string; expected_sha256: string | null; size_bytes: number; source: string }[]> {
    const rows = await this.db.client.$queryRaw<{ storage_key: string; expected_sha256: string | null; size_bytes: bigint; source: string }[]>(
      Prisma.sql`SELECT * FROM storage_legacy_candidates(${limit}::int)`);
    return rows.map((r) => ({ ...r, size_bytes: Number(r.size_bytes) }));
  }
  async expiredExports(limit: number): Promise<{ export_id: string; storage_key: string; expires_at: Date }[]> {
    return this.db.client.$queryRaw(Prisma.sql`SELECT export_id::text, storage_key, expires_at FROM storage_expired_exports(${limit}::int)`);
  }
  async exportPurged(exportId: string): Promise<void> {
    await this.db.client.$executeRaw(Prisma.sql`SELECT storage_export_purged(${exportId}::uuid)`);
  }
  async malwareAlert(title: string, detail: Record<string, unknown>, dedup: string): Promise<void> {
    await this.db.client.$executeRaw(Prisma.sql`SELECT storage_malware_alert(${title}::text, ${JSON.stringify(detail)}::jsonb, ${dedup}::text, NULL::uuid)`);
  }
}

/** The encryption, scan and envelope layer over a raw driver. Used by StorageService and by the maintenance jobs. */
export class ProtectedStorage implements ObjectStorage {
  readonly driver: 's3' | 'local';
  private readonly log = new Logger('Storage');
  constructor(
    private readonly raw: ObjectStorage,
    private readonly meta: MetaStore,
    private readonly keys: MasterKeys,
    private readonly scanner: Scanner | null,
    private readonly scanFailure: 'fail_closed' | 'fail_open',
    private readonly events: StorageEvents,
  ) {
    this.driver = raw.driver;
  }

  get scanning(): boolean {
    return this.scanner !== null;
  }

  /** Scans an upload. Returns the scan status to store: clean, or pending_rescan when clamd was down and SCAN_FAILURE is fail_open. */
  private async scanUpload(key: string, body: Buffer): Promise<'clean' | 'pending_rescan'> {
    if (!this.scanner) return 'clean';
    try {
      const v = await this.scanner.scan(body);
      if (!v.infected) return 'clean';
      const sha = sha256Hex(body);
      await this.events.log('warn', 'upload refused: malware', { storage_key: key, signature: v.signature, size_bytes: body.length, sha256: sha });
      await this.meta.malwareAlert('A file upload was refused: malware found', { storage_key: key, signature: v.signature, size_bytes: body.length, sha256: sha, stage: 'upload' }, `malware_upload:${key}`);
      throw new ProblemException(422, 'file_rejected', {
        detail: 'The file contains malware and was not stored.', extra: { reason: 'malware' },
        errors: [{ path: '/file', code: 'malware', message: 'The file was refused by the virus scan.' }],
      });
    } catch (e) {
      if (!(e instanceof ScannerUnavailable)) throw e;
      if (this.scanFailure === 'fail_closed') {
        await this.events.log('error', 'upload refused: virus scanner unavailable', { storage_key: key, reason: e.message });
        throw new ProblemException(503, 'malware_scan_unavailable', { detail: 'The virus scanner is not available: try again later.' });
      }
      await this.events.log('warn', 'upload accepted without a virus scan (fail_open): flagged for rescan', { storage_key: key, reason: e.message });
      return 'pending_rescan';
    }
  }

  /** Encrypts a stream into a new object and writes its envelope. The object is removed again when the envelope cannot be written. */
  private async encryptAndStore(key: string, source: Readable, size: number, scan: 'clean' | 'pending_rescan', replace = false): Promise<void> {
    const { dataKey, nonce } = newDataKey();
    const master = this.keys.keys.get(this.keys.activeId);
    if (!master) throw new Error('no active master key');
    const wrapped = wrapDataKey(master, dataKey);
    const enc = new GcmEncryptor(dataKey, nonce);
    const tap = new Sha256Tap();
    await this.raw.putStream(key, source.pipe(tap.stream).pipe(enc.stream), size, replace);
    const row: Envelope = {
      storage_key: key, driver: this.raw.driver, key_id: this.keys.activeId, wrapped_key: wrapped, nonce, tag: enc.tag(),
      plain_sha256: tap.digest(), size_bytes: size, scan_status: scan,
    };
    try {
      await this.meta.put(row, replace);
    } catch (e) {
      if (!replace) await this.raw.remove(key).catch(() => undefined);
      throw e;
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    checkKey(key);
    const scan = await this.scanUpload(key, body);
    await this.encryptAndStore(key, Readable.from(chunked(body)), body.length, scan);
  }

  async putFile(key: string, path: string, size: number): Promise<void> {
    checkKey(key);
    await this.encryptAndStore(key, createReadStream(path), size, 'clean');   // generated content (zip exports): not scanned
  }

  async putStream(key: string, body: Readable, size: number, replace = false): Promise<void> {
    checkKey(key);
    await this.encryptAndStore(key, body, size, 'clean', replace);
  }

  async get(key: string): Promise<Readable> {
    checkKey(key);
    const row = await this.meta.get(key);
    if (!row) return this.raw.get(key);                     // legacy plaintext object
    if (row.scan_status === 'infected') throw new ProblemException(404, 'not_found', { detail: 'The file does not exist.' });
    const master = this.keys.keys.get(row.key_id);
    if (!master) throw new Error(`no master key for ${row.key_id}`);
    const dataKey = unwrapDataKey(master, row.wrapped_key);
    const raw = await this.raw.get(key);
    const dec = gcmDecryptStream(dataKey, row.nonce, row.tag);
    raw.once('error', (e) => dec.destroy(e));
    raw.pipe(dec);
    // No plaintext leaves before the GCM tag is verified (security review of 0048): GCM authenticates only at the end of the stream,
    // so the whole object is decrypted and checked first, in memory for ordinary files and through a private temp file for large ones.
    if (Number(row.size_bytes) <= VERIFY_IN_MEMORY_BYTES) {
      const parts: Buffer[] = [];
      for await (const c of dec) parts.push(c as Buffer);     // throws on a wrong tag, before anything is returned
      return Readable.from([Buffer.concat(parts)]);
    }
    const tmp = join(tmpdir(), `pmis-dec-${randomUUID()}`);
    try {
      await pipeline(dec, createWriteStream(tmp, { mode: 0o600 }));   // the tag is checked when the pipeline ends
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    const out = createReadStream(tmp);
    const cleanup = () => { void fs.rm(tmp, { force: true }); };
    out.once('close', cleanup);
    out.once('error', cleanup);
    return out;
  }

  async remove(key: string): Promise<void> {
    checkKey(key);
    await this.raw.remove(key);
    await this.meta.delete(key);
  }

  /** Decrypts an object and compares its SHA-256 and size with the envelope. Returns null when they agree, else the reason. */
  async verify(key: string): Promise<string | null> {
    const row = await this.meta.get(key);
    if (!row) return 'no envelope row';
    try {
      const body = await this.readPlainRaw(key);
      if (body.length !== row.size_bytes) return `size ${body.length}, expected ${row.size_bytes}`;
      if (sha256Hex(body) !== row.plain_sha256) return 'SHA-256 differs from the recorded value';
      return null;
    } catch (e) {
      return e instanceof Error ? e.message.split('\n')[0] ?? 'unreadable' : 'unreadable';
    }
  }

  /** Plain bytes of an object, for maintenance (rescan, verify, re-encrypt). Legacy objects are read as they are. */
  async readPlain(key: string): Promise<Buffer> {
    const s = await this.get(key);
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    return Buffer.concat(chunks);
  }

  /** Rescans the plain bytes of an object that was stored while clamd was down. Returns the new status. */
  async rescan(key: string): Promise<'clean' | 'infected' | 'pending_rescan'> {
    if (!this.scanner) return 'pending_rescan';
    const row = await this.meta.get(key);
    if (!row) return 'clean';
    try {
      const body = await this.readPlainRaw(key);
      const v = await this.scanner.scan(body);
      if (v.infected) {
        await this.meta.setScan(key, 'infected');
        await this.meta.malwareAlert('A stored file was found to contain malware on rescan', { storage_key: key, signature: v.signature, stage: 'rescan' }, `malware_rescan:${key}`);
        await this.events.log('error', 'rescan found malware: the file is quarantined', { storage_key: key, signature: v.signature });
        return 'infected';
      }
      await this.meta.setScan(key, 'clean');
      return 'clean';
    } catch (e) {
      if (e instanceof ScannerUnavailable) return 'pending_rescan';
      throw e;
    }
  }

  private async readPlainRaw(key: string): Promise<Buffer> {
    const row = await this.meta.get(key);
    if (!row) return this.readPlain(key);
    const master = this.keys.keys.get(row.key_id);
    if (!master) throw new Error(`no master key for ${row.key_id}`);
    const dec = gcmDecryptStream(unwrapDataKey(master, row.wrapped_key), row.nonce, row.tag);
    const raw = await this.raw.get(key);
    raw.once('error', (e) => dec.destroy(e));
    raw.pipe(dec);
    const chunks: Buffer[] = [];
    for await (const c of dec) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    return Buffer.concat(chunks);
  }

  /** Rewraps the data keys of the envelopes that are not under the active master key. The content is not read or written. */
  async rewrapBatch(limit: number): Promise<{ rewrapped: number; failed: number }> {
    const master = this.keys.keys.get(this.keys.activeId);
    if (!master) throw new Error('no active master key');
    const rows = await this.meta.rotationBatch(this.keys.activeId, limit);
    let rewrapped = 0, failed = 0;
    for (const r of rows) {
      const old = this.keys.keys.get(r.key_id);
      if (!old) {
        failed++;
        continue;
      }
      try {
        const dk = unwrapDataKey(old, r.wrapped_key);
        const ok = await this.meta.rewrap(r.storage_key, r.key_id, this.keys.activeId, wrapDataKey(master, dk));
        if (ok) rewrapped++;
      } catch {
        failed++;
      }
    }
    return { rewrapped, failed };
  }

  /** One-off: encrypts a legacy plaintext object in place. The envelope is written first and removed again if the object cannot be replaced. */
  async encryptLegacy(key: string, expectedSha256: string | null): Promise<'encrypted' | 'skipped' | 'mismatch'> {
    checkKey(key);
    if (await this.meta.get(key)) return 'skipped';
    const plainStream = await this.raw.get(key);
    const tmp = join(tmpdir(), `pmis-enc-${randomUUID()}`);
    const { dataKey, nonce } = newDataKey();
    const master = this.keys.keys.get(this.keys.activeId);
    if (!master) throw new Error('no active master key');
    const enc = new GcmEncryptor(dataKey, nonce);
    const tap = new Sha256Tap();
    let size = 0;
    const counter = new Transform({ transform(c: Buffer, _e, cb) { size += c.length; cb(null, c); } });
    try {
      await pipeline(plainStream, tap.stream, counter, enc.stream, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      if (expectedSha256 && tap.digest() !== expectedSha256) return 'mismatch';
      const row: Envelope = {
        storage_key: key, driver: this.raw.driver, key_id: this.keys.activeId, wrapped_key: wrapDataKey(master, dataKey), nonce: Buffer.from(nonce),
        tag: enc.tag(), plain_sha256: tap.digest(), size_bytes: size, scan_status: 'clean',
      };
      await this.meta.put(row, false);
      try {
        await this.raw.putStream(key, createReadStream(tmp), size, true);
      } catch (e) {
        await this.meta.delete(key);
        throw e;
      }
      return 'encrypted';
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
}

function* chunked(body: Buffer, size = 64 * 1024): Generator<Buffer> {
  for (let off = 0; off < body.length; off += size) yield body.subarray(off, off + size);
  if (body.length === 0) yield Buffer.alloc(0);
}

/** Builds the scanner from the configuration (null when MALWARE_SCAN is off). */
export function scannerFor(scan: ScanConfig): Scanner | null {
  if (scan.mode !== 'clamd') return null;
  return new ClamdScanner({ socket: scan.socket, host: scan.host, port: scan.port, timeoutMs: scan.timeoutMs });
}

/** Objects up to this size are decrypted and verified in memory before release; larger ones go through a private temp file. */
const VERIFY_IN_MEMORY_BYTES = 64 * 1024 * 1024;

@Injectable()
export class StorageService {
  readonly store: ProtectedStorage;
  readonly meta: MetaStore;
  private readonly logger = new Logger('StorageService');
  constructor(@Inject(APP_CONFIG) config: AppConfig, db: DbService, syslog: SyslogService) {
    const scanner = scannerFor(config.scan);
    if (!scanner) this.logger.warn('MALWARE_SCAN is off: uploads are stored without a virus scan');
    this.meta = new DbMetaStore(db);
    this.store = new ProtectedStorage(storageFor(config.storage), this.meta, config.fileEnc, scanner, config.scan.onFailure, {
      log: (level, message, context) => syslog.write(level, message, context, undefined, undefined, 'storage'),
    });
  }
}

