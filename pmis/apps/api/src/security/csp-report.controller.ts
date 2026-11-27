import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { RateLimiter } from '../auth/rate-limiter';
import { problems } from '../common/problem';

const PER_MINUTE = 30;
const MAX_KEYS = 50;

/** A report is untrusted text from a browser: keep only short, plain fields, and no query string or path of another site. */
export interface CspViolation { directive: string; blocked: string; page: string; disposition: string }
const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '?').slice(0, n) : '');
const originOnly = (v: unknown): string => {
  const s = clip(v, 300);
  if (!s || s === 'inline' || s === 'eval' || s === 'data' || s === 'blob' || s === 'self') return s;
  try { return new URL(s).origin; } catch { return s.split(/[?#]/)[0]!.slice(0, 40); }
};
const pathOnly = (v: unknown): string => { try { return new URL(clip(v, 300)).pathname.slice(0, 120); } catch { return ''; } };

/** Reads both report formats: the old `application/csp-report` ({"csp-report": {...}}) and Reporting API (`application/reports+json`, a list). */
export function violationsOf(body: unknown): CspViolation[] {
  const one = (r: Record<string, unknown>): CspViolation => ({
    directive: clip(r['effective-directive'] ?? r['effectiveDirective'] ?? r['violated-directive'] ?? r['violatedDirective'], 60),
    blocked: originOnly(r['blocked-uri'] ?? r['blockedURL'] ?? r['blockedUri']),
    page: pathOnly(r['document-uri'] ?? r['documentURL'] ?? r['documentUri']),
    disposition: clip(r['disposition'], 12),
  });
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (Array.isArray(body)) return body.filter(isObj).filter((x) => x['type'] === 'csp-violation' && isObj(x['body'])).slice(0, 10).map((x) => one(x['body'] as Record<string, unknown>));
  if (isObj(body) && isObj(body['csp-report'])) return [one(body['csp-report'])];
  return [];
}

/**
 * SEC-3: where browsers report Content-Security-Policy violations (the policy is sent by nginx, report-only first). Public on purpose, because a browser sends the
 * report without the session. It cannot change anything: it logs a short, sanitised line, counts per directive in memory, and is rate limited per address.
 */
@Controller('csp-report')
export class CspReportController {
  private readonly log = new Logger('csp');
  private readonly counts = new Map<string, number>();
  constructor(private readonly limiter: RateLimiter) {}

  @Public()
  @Post()
  @HttpCode(204)
  report(@Req() req: Request & { body?: unknown }): void {
    const wait = this.limiter.hit(`csp:${req.ip ?? 'unknown'}`, PER_MINUTE);
    if (wait) throw problems.rateLimited(wait);
    for (const v of violationsOf(req.body)) {
      const key = `${v.directive}|${v.blocked}`;
      if (!this.counts.has(key) && this.counts.size >= MAX_KEYS) continue;
      const n = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, n);
      if (n === 1 || n % 100 === 0) this.log.warn(`csp violation ${v.disposition || 'report'} directive=${v.directive} blocked=${v.blocked} page=${v.page} seen=${n}`);
    }
  }
}
