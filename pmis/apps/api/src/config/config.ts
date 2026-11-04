import { z } from 'zod';
import { parseEncKey } from '../auth/totp';
import { MasterKeys, parseMasterKeys } from '../documents/file-crypto';
import { parseContextKey } from '../db/session-context';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  LOG_HMAC_KEY: z.string().min(16, 'LOG_HMAC_KEY must be at least 16 characters'),
  // 32 bytes (64 hex characters or base64): AES-256-GCM key for the TOTP secrets and base of the recovery-code hash key. Generate: openssl rand -hex 32
  TOTP_ENC_KEY: z.string().refine((v) => parseEncKey(v) !== null, 'TOTP_ENC_KEY must be 32 bytes: 64 hex characters (openssl rand -hex 32) or base64'),
  // Session context key (migration 0069, ADR 0003 section 6): 32 bytes as 64 hex characters. The API signs every transaction's context with it; the database holds the
  // same key in pmis_context_keys and verifies. Generate once: openssl rand -hex 32. Never log it.
  PMIS_CONTEXT_KEY: z.string().refine((v) => parseContextKey(v) !== null, 'PMIS_CONTEXT_KEY must be 32 bytes as 64 hex characters (openssl rand -hex 32)'),
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
  // Encryption at rest (migration 0048, ADR 0008 amendment): the active master key, its id, and the earlier keys kept while data keys are rewrapped.
  FILE_ENC_KEY: z.string().min(1, 'FILE_ENC_KEY is required (openssl rand -hex 32)'),
  FILE_ENC_KEY_ID: z.string().optional(),
  FILE_ENC_OLD_KEYS: z.string().optional(),
  // Virus scan (owner answer Q134). MALWARE_SCAN=clamd scans every upload with clamd (CLAMD_SOCKET, or CLAMD_HOST and CLAMD_PORT).
  // SCAN_FAILURE decides what happens when clamd is unreachable: fail_closed refuses the upload (503), fail_open stores it and flags it for rescan.
  MALWARE_SCAN: z.enum(['off', 'clamd']).optional(),
  CLAMD_SOCKET: z.string().optional(),
  CLAMD_HOST: z.string().optional(),
  CLAMD_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  CLAMD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(900000).optional(),
  SCAN_FAILURE: z.enum(['fail_closed', 'fail_open']).optional(),
  // Outbound mail (owner answer Q167, migration 0055). Off when SMTP_HOST is empty: the queue then records what it would have sent.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_TLS: z.enum(['starttls', 'tls', 'none']).optional(),
  SMTP_TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).optional(),
  SMTP_CA_FILE: z.string().optional(),
  SMTP_ALLOW_PLAIN_AUTH: z.enum(['true', 'false']).optional(),
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).optional(),
  SMTP_HELO_NAME: z.string().optional(),
  // Base of the links in mails, for example https://pmis.aljeel.local (no trailing slash). Empty: the links stay relative.
  APP_BASE_URL: z.string().optional(),
  APP_URL: z.string().optional(),
  // The chain heads of the nightly integrity check are appended here (Q171): keep it outside the database and copy it off the server.
  LOG_ANCHOR_DIR: z.string().optional(),
});

export interface ScanConfig {
  mode: 'off' | 'clamd';
  socket?: string;
  host: string;
  port: number;
  timeoutMs: number;
  onFailure: 'fail_closed' | 'fail_open';
}

export interface StorageConfig {
  driver: 's3' | 'local';
  /** Directory of the local driver (also created when it is missing). */
  localDir: string;
  s3?: { endpoint: string; bucket: string; accessKey: string; secretKey: string; region: string };
}

export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** starttls (upgrade on the plain port, refused when the server does not offer it), tls (implicit TLS, port 465) or none. */
  tls: 'starttls' | 'tls' | 'none';
  user?: string;
  pass?: string;
  /** The address in MAIL FROM, and the From header (with the display name when one was given). */
  fromAddress: string;
  fromHeader: string;
  rejectUnauthorized: boolean;
  caFile?: string;
  timeoutMs: number;
  heloName: string;
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
  /** PMIS_CONTEXT_KEY (validated: 64 hex characters). Signs the session context of every transaction (migration 0069). */
  contextKey: string;
  /** Runs the daily job (SLA versions due, tentative-holiday reminder) at start-up and at 02:00 Africa/Tripoli. */
  jobsEnabled: boolean;
  /** Where document files and zip exports are kept. */
  storage: StorageConfig;
  /** Master keys of the envelope encryption of stored files (FILE_ENC_KEY). */
  fileEnc: MasterKeys;
  /** The virus scan of uploads. */
  scan: ScanConfig;
  /** Outbound mail (migration 0055). Absent or enabled=false: mails are recorded in the outbox as `logged`, never sent. */
  mail?: MailConfig;
  /** Base of the links in mails. */
  appBaseUrl?: string;
  /** Directory of the external anchor files of the integrity check. */
  anchorDir?: string;
}

const ADDR_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** "GSDN PMIS <pmis@example.ly>" or "pmis@example.ly". Returns null when it is not one of the two forms (no line breaks, no quotes). */
export function parseFrom(v: string): { address: string; header: string } | null {
  const t = v.trim();
  const m = /^([^<>"\r\n]{1,80}?)\s*<([^<>\s]+)>$/.exec(t);
  if (m) {
    const name = (m[1] as string).trim();
    const address = m[2] as string;
    if (!ADDR_RE.test(address) || !/^[\p{L}\p{N} .,_()&'-]+$/u.test(name)) return null;
    return { address, header: `${name} <${address}>` };
  }
  return ADDR_RE.test(t) ? { address: t, header: t } : null;
}

function mailFrom(v: z.infer<typeof schema>): MailConfig {
  const e = (x: string | undefined): string | undefined => (x && x.trim() !== '' ? x.trim() : undefined);
  const host = e(v.SMTP_HOST);
  const tls = v.SMTP_TLS ?? (v.SMTP_PORT === 465 ? 'tls' : 'starttls');
  const base = {
    host: host ?? '', port: v.SMTP_PORT ?? (tls === 'tls' ? 465 : 587), tls, rejectUnauthorized: v.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
    caFile: e(v.SMTP_CA_FILE), timeoutMs: v.SMTP_TIMEOUT_MS ?? 15_000, heloName: e(v.SMTP_HELO_NAME) ?? 'pmis.localdomain',
  } as const;
  if (!host) return { ...base, enabled: false, fromAddress: '', fromHeader: '' };
  const problems: string[] = [];
  const from = e(v.SMTP_FROM) ? parseFrom(v.SMTP_FROM as string) : null;
  if (!from) problems.push('SMTP_FROM must be an address or "Name <address>" when SMTP_HOST is set');
  const user = e(v.SMTP_USER);
  const pass = v.SMTP_PASS && v.SMTP_PASS !== '' ? v.SMTP_PASS : undefined;
  if ((user === undefined) !== (pass === undefined)) problems.push('SMTP_USER and SMTP_PASS go together (both or neither)');
  if (user && tls === 'none' && v.SMTP_ALLOW_PLAIN_AUTH !== 'true') {
    problems.push('SMTP_TLS=none would send the SMTP password in clear: use starttls or tls, or set SMTP_ALLOW_PLAIN_AUTH=true for a relay on the same host');
  }
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(base.heloName)) problems.push('SMTP_HELO_NAME must be a host name');
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  return { ...base, enabled: true, user, pass, fromAddress: (from as { address: string }).address, fromHeader: (from as { header: string }).header };
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

function fileEncFrom(v: z.infer<typeof schema>): MasterKeys {
  try {
    return parseMasterKeys({ FILE_ENC_KEY: v.FILE_ENC_KEY, FILE_ENC_KEY_ID: v.FILE_ENC_KEY_ID, FILE_ENC_OLD_KEYS: v.FILE_ENC_OLD_KEYS });
  } catch (e) {
    throw new Error(`Invalid configuration:\n  FILE_ENC_KEY: ${e instanceof Error ? e.message : 'invalid'}`);
  }
}

function scanFrom(v: z.infer<typeof schema>): ScanConfig {
  const socket = v.CLAMD_SOCKET && v.CLAMD_SOCKET.trim() !== '' ? v.CLAMD_SOCKET.trim() : undefined;
  return {
    mode: v.MALWARE_SCAN ?? 'off',
    socket,
    host: v.CLAMD_HOST && v.CLAMD_HOST.trim() !== '' ? v.CLAMD_HOST.trim() : '127.0.0.1',
    port: v.CLAMD_PORT ?? 3310,
    timeoutMs: v.CLAMD_TIMEOUT_MS ?? 120_000,
    onFailure: v.SCAN_FAILURE ?? 'fail_closed',
  };
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
    contextKey: v.PMIS_CONTEXT_KEY.trim(),
    jobsEnabled: v.JOBS_ENABLED === undefined ? v.NODE_ENV !== 'test' : v.JOBS_ENABLED === 'true',
    storage: storageFrom(v),
    fileEnc: fileEncFrom(v),
    scan: scanFrom(v),
    mail: mailFrom(v),
    appBaseUrl: (() => { const u = (v.APP_BASE_URL ?? '').trim() || (v.APP_URL ?? '').trim(); return u ? u.replace(/\/+$/, '') : undefined; })(),
    anchorDir: v.LOG_ANCHOR_DIR && v.LOG_ANCHOR_DIR.trim() !== '' ? v.LOG_ANCHOR_DIR.trim() : undefined,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
