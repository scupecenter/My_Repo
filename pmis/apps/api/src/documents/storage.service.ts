import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_CONFIG, AppConfig } from '../config/config';

/** The things the documents module needs from object storage. Keys are opaque and random; nothing in a key comes from a user. */
export interface ObjectStorage {
  readonly driver: 's3' | 'local';
  put(key: string, body: Buffer): Promise<void>;
  putFile(key: string, path: string, size: number): Promise<void>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9]+(\/[a-z0-9-]+)+$/;

function checkKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..')) throw new Error('invalid storage key');
}

/** Files on local disk (small installs, tests). Created with mode 0600 inside the configured directory, never overwritten. */
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
    const p = this.path(key);
    await fs.mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await pipeline(createReadStream(path), createWriteStream(p, { flags: 'wx', mode: 0o600 }));
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
    checkKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: createReadStream(path), ContentLength: size, ContentType: 'application/octet-stream' }));
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

@Injectable()
export class StorageService {
  readonly store: ObjectStorage;
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.store = storageFor(config.storage);
  }
}
