import { Prisma } from '@prisma/client';
import { isIP } from 'node:net';
import type { Request } from 'express';
import type { Tx } from '../db/db.service';
import type { AuthContext } from '../auth/auth.types';

/** What the database records about the device behind a request (migration 0045, `audit_log.device`, `security_log.device`). */
export interface Device {
  browser: string;
  os: string;
  type: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'other';
}

/** The request context the database copies into every audit and security log row (transaction-local app.* settings). */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  sessionId?: string | null;
  /** local or oidc (M365); break_glass for the break-glass account. */
  authMethod?: 'local' | 'oidc' | 'break_glass' | null;
  mfa?: boolean | null;
  stepup?: boolean | null;
  /** manual (a person in the web app), api (a bearer client, later), job (a background job). bulk and batch are set by the services. */
  via?: 'manual' | 'api' | 'job' | 'bulk' | 'button' | 'drag';
  jobName?: string | null;
}

export const UA_MAX = 400;

/** A small, dependency-free User-Agent reader. Good enough for an audit trail ("Chrome on Windows, desktop"); never used for a decision. */
export function parseDevice(ua: string | null | undefined): Device | null {
  if (!ua) return null;
  const s = ua.slice(0, UA_MAX);
  const bot = /bot|crawler|spider|curl|wget|python-requests|okhttp|node-fetch|axios|postman/i.test(s);
  let browser = 'Other';
  if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/SamsungBrowser\//.test(s)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari';
  else if (/curl\//i.test(s)) browser = 'curl';
  let os = 'Other';
  if (/Windows NT/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';
  let type: Device['type'] = 'desktop';
  if (bot) type = 'bot';
  else if (/iPad|Tablet|(Android(?!.*Mobile))/.test(s)) type = 'tablet';
  else if (/Mobi|iPhone|iPod|Android/.test(s)) type = 'mobile';
  else if (os === 'Other' && browser === 'Other') type = 'other';
  return { browser, os, type };
}

export function contextFromRequest(req: Request, auth?: AuthContext, stepup?: boolean): RequestContext {
  const ua = req.header('user-agent') ?? null;
  const ip = req.ip && isIP(req.ip) ? req.ip : null;
  return {
    ip,
    userAgent: ua ? ua.slice(0, UA_MAX) : null,
    requestId: req.id ?? null,
    sessionId: auth?.session.id ?? null,
    authMethod: auth ? (auth.session.authMethod === 'm365' ? 'oidc' : auth.session.authMethod) : null,
    mfa: auth ? auth.session.twoFactor : null,
    stepup: stepup ?? null,
    via: 'manual',
  };
}

/** Sets the app.* settings of the transaction (set_config(..., true)). The database never trusts them for rights; it records them. */
export async function applyContext(tx: Tx, c: RequestContext): Promise<void> {
  const device = parseDevice(c.userAgent);
  await tx.$queryRaw(Prisma.sql`SELECT set_config('app.ip', ${c.ip ?? ''}, true), set_config('app.user_agent', ${(c.userAgent ?? '').slice(0, UA_MAX)}, true),
    set_config('app.request_id', ${c.requestId ?? ''}, true), set_config('app.session_id', ${c.sessionId ?? ''}, true),
    set_config('app.auth_method', ${c.authMethod ?? ''}, true), set_config('app.mfa', ${c.mfa === null || c.mfa === undefined ? '' : String(c.mfa)}, true),
    set_config('app.stepup', ${c.stepup === null || c.stepup === undefined ? '' : String(c.stepup)}, true), set_config('app.via', ${c.via ?? ''}, true),
    set_config('app.device', ${device ? JSON.stringify(device) : ''}, true), set_config('app.job_name', ${c.jobName ?? ''}, true)`);
}

/** The context of a background job: no person, no device, `via = job`. */
export const jobContext = (name: string): RequestContext => ({ ip: null, userAgent: null, requestId: null, via: 'job', jobName: name });

/** The same context, as the p_ctx object of sec_log_write (explicit values win over the settings). */
export function secCtx(c: RequestContext): Record<string, unknown> {
  return {
    ip: c.ip, user_agent: c.userAgent, request_id: c.requestId, session_id: c.sessionId ?? null, device: parseDevice(c.userAgent),
    client_type: c.authMethod === 'break_glass' ? 'break_glass' : 'web',
  };
}
