import { createHmac } from 'node:crypto';
import type { Tx } from './db.service';

/**
 * The verified session context (migration 0069, ADR 0003 section 6).
 *
 * Every transaction that needs the database to know who acts starts with `app_begin(ctx, sig)`. The signature is an HMAC-SHA256 with the secret context
 * key (PMIS_CONTEXT_KEY, hex) over the canonical text of the context and the transaction id, so it is valid in this transaction only. The database derives
 * the user's regions, admin status and delegation from its own data; nothing the API says about rights is trusted.
 *
 * This file is the only place that builds and signs a context. The key is never logged or printed.
 */

/** The fields of the signed context, in the order the database canonicalises them (app_ctx_canon in 0069). */
export const CONTEXT_FIELDS = [
  'v', 'user_id', 'on_behalf', 'session_id', 'auth_method', 'mfa', 'stepup_until', 'via', 'request_id', 'ip', 'user_agent', 'device', 'job_name', 'issued_at',
] as const;

export type ContextWire = Partial<Record<(typeof CONTEXT_FIELDS)[number], string | boolean | null>>;

/** What a caller says about the transaction. Only `userId` matters for rights, and the database checks it against its data. */
export interface ContextInput {
  /** The signed-in (or signing-in) user. Null: a job with no person (no actor, no region). */
  userId?: string | null;
  /** A delegation id the user works under; refused by the database unless it is an effective delegation to this user. */
  onBehalf?: string | null;
  sessionId?: string | null;
  authMethod?: 'local' | 'oidc' | 'break_glass' | null;
  mfa?: boolean | null;
  /** When the step-up of the session ends (the database says "step-up verified" only while this is in the future). */
  stepupUntil?: Date | null;
  via?: 'manual' | 'api' | 'job' | 'bulk' | 'button' | 'drag' | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** JSON text of the parsed device (informational). */
  device?: string | null;
  jobName?: string | null;
}

let contextKey: Buffer | null = null;

/** 32 bytes as 64 hex characters (openssl rand -hex 32). */
export function parseContextKey(hex: string | undefined | null): Buffer | null {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) return null;
  return Buffer.from(hex.trim(), 'hex');
}

/** Called once by DbService with PMIS_CONTEXT_KEY. */
export function setContextKey(key: Buffer): void {
  contextKey = key;
}

/** The text that is signed. Mirror of app_ctx_canon: each field as <length in bytes>:<value>, a missing value as '-', joined with '|'. */
export function canonicalContext(w: ContextWire): string {
  return CONTEXT_FIELDS.map((k) => {
    const v = w[k];
    if (v === undefined || v === null) return '-';
    const s = String(v);
    return `${Buffer.byteLength(s, 'utf8')}:${s}`;
  }).join('|');
}

/** HMAC-SHA256(key, 'begin|' + txid + '|' + canonical context). */
export function signContext(key: Buffer, txid: string, w: ContextWire): Buffer {
  return createHmac('sha256', key).update(`begin|${txid}|${canonicalContext(w)}`, 'utf8').digest();
}

/** Control characters (a NUL cannot be stored in jsonb) become spaces; the signed text is the cleaned one. */
const clean = (v: string | null | undefined): string | null =>
  v === undefined || v === null ? null : Array.from(v, (ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch)).join('');

export function toWire(c: ContextInput, now: Date = new Date()): ContextWire {
  return {
    v: '1',
    user_id: c.userId ?? null,
    on_behalf: c.onBehalf ?? null,
    session_id: clean(c.sessionId),
    auth_method: c.authMethod ?? null,
    mfa: c.mfa === undefined ? null : c.mfa,
    stepup_until: c.stepupUntil ? c.stepupUntil.toISOString() : null,
    via: c.via ?? null,
    request_id: clean(c.requestId),
    ip: clean(c.ip),
    user_agent: c.userAgent ? clean(c.userAgent.slice(0, 400)) : null,
    device: clean(c.device),
    job_name: clean(c.jobName),
    issued_at: now.toISOString(),
  };
}

export interface BeganContext {
  user_id: string | null;
  admin: boolean;
  regions: string;
}

/**
 * Starts the verified context of the transaction `tx`: reads txid_current(), signs, calls app_begin. Must be the first thing the transaction does for the
 * caller's rights (the database refuses a context that is older than 30 seconds). Throws when the key is not configured or the database refuses.
 */
export async function beginContext(tx: Tx, input: ContextInput, key: Buffer | null = contextKey): Promise<BeganContext> {
  if (!key) throw new Error('PMIS_CONTEXT_KEY is not configured: the database context cannot be signed');
  const t = await tx.$queryRaw<{ txid: string }[]>`SELECT txid_current()::text AS txid`;
  const txid = t[0]?.txid;
  if (!txid) throw new Error('cannot read the transaction id');
  const wire = toWire(input);
  const sig = signContext(key, txid, wire);
  const r = await tx.$queryRaw<{ ctx: BeganContext }[]>`SELECT app_begin(${JSON.stringify(wire)}::jsonb, ${sig}::bytea) AS ctx`;
  return r[0]?.ctx as BeganContext;
}
