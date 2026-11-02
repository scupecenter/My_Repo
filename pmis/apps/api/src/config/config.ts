import { z } from 'zod';
import { parseEncKey } from '../auth/totp';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  LOG_HMAC_KEY: z.string().min(16, 'LOG_HMAC_KEY must be at least 16 characters'),
  // 32 bytes (64 hex characters or base64): AES-256-GCM key for the TOTP secrets and base of the recovery-code hash key. Generate: openssl rand -hex 32
  TOTP_ENC_KEY: z.string().refine((v) => parseEncKey(v) !== null, 'TOTP_ENC_KEY must be 32 bytes: 64 hex characters (openssl rand -hex 32) or base64'),
  // Daily job (owner answer Q84). Absent = on, except when NODE_ENV=test.
  JOBS_ENABLED: z.enum(['true', 'false']).optional(),
  // Document storage (ADR 0008). S3-compatible object storage (MinIO on-prem) when all of S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY are set;
  // otherwise a directory on local disk (small installs and tests).
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  STORAGE_DIR: z.string().optional(),
});

export interface StorageConfig {
  driver: 's3' | 'local';
  /** Directory of the local driver (also created when it is missing). */
  localDir: string;
  s3?: { endpoint: string; bucket: string; accessKey: string; secretKey: string; region: string };
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  port: number;
  host: string;
  cookieSecure: boolean;
  logHmacKey: string;
  /** Raw text of TOTP_ENC_KEY (validated: 32 bytes). */
  totpEncKey: string;
  /** Runs the daily job (SLA versions due, tentative-holiday reminder) at start-up and at 02:00 Africa/Tripoli. */
  jobsEnabled: boolean;
  /** Where document files and zip exports are kept. */
  storage: StorageConfig;
}

function storageFrom(v: z.infer<typeof schema>): StorageConfig {
  const localDir = v.STORAGE_DIR && v.STORAGE_DIR.trim() !== '' ? v.STORAGE_DIR : './storage';
  const e = (x: string | undefined): string | undefined => (x && x.trim() !== '' ? x.trim() : undefined);
  const endpoint = e(v.S3_ENDPOINT), bucket = e(v.S3_BUCKET), accessKey = e(v.S3_ACCESS_KEY), secretKey = e(v.S3_SECRET_KEY);
  const some = [endpoint, bucket, accessKey, secretKey].filter((x) => x !== undefined).length;
  if (some > 0 && some < 4) {
    throw new Error('Invalid configuration:\n  S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY must all be set to use S3 storage (or none, for local disk)');
  }
  if (endpoint && bucket && accessKey && secretKey) return { driver: 's3', localDir, s3: { endpoint, bucket, accessKey, secretKey, region: v.S3_REGION } };
  return { driver: 'local', localDir };
}

/** Reads the settings from the environment only. Throws one readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const v = parsed.data;
  return {
    nodeEnv: v.NODE_ENV,
    databaseUrl: v.DATABASE_URL,
    port: v.PORT,
    host: v.HOST,
    cookieSecure: v.COOKIE_SECURE,
    logHmacKey: v.LOG_HMAC_KEY,
    totpEncKey: v.TOTP_ENC_KEY,
    jobsEnabled: v.JOBS_ENABLED === undefined ? v.NODE_ENV !== 'test' : v.JOBS_ENABLED === 'true',
    storage: storageFrom(v),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
