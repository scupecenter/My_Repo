import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter';
import { violationsOf } from '../src/security/csp-report.controller';
import { API, startApp } from './helpers';

/** SEC-3: the CSP report endpoint is public, tiny, sanitised and rate limited, and it changes nothing. */
let app: NestExpressApplication;
beforeAll(async () => { app = await startApp(); });
beforeEach(() => app.get(RateLimiter).reset());
afterAll(async () => { await app.close(); });

const legacy = { 'csp-report': { 'document-uri': 'https://pmis.example/projects?token=SECRET', 'effective-directive': 'img-src', 'blocked-uri': 'https://evil.example/pixel.png?x=1', disposition: 'report' } };

describe('csp-report parsing', () => {
  it('keeps only the directive, the origin of the blocked address and the page path', () => {
    expect(violationsOf(legacy)).toEqual([{ directive: 'img-src', blocked: 'https://evil.example', page: '/projects', disposition: 'report' }]);
  });
  it('reads the Reporting API list and ignores other report types and junk', () => {
    const v = violationsOf([{ type: 'csp-violation', body: { effectiveDirective: 'script-src', blockedURL: 'inline', documentURL: 'https://a.example/x', disposition: 'enforce' } }, { type: 'deprecation', body: {} }, 5, null]);
    expect(v).toEqual([{ directive: 'script-src', blocked: 'inline', page: '/x', disposition: 'enforce' }]);
    expect(violationsOf('x')).toEqual([]);
    expect(violationsOf({ nope: 1 })).toEqual([]);
  });
  it('clips long and non-printable text', () => {
    const v = violationsOf({ 'csp-report': { 'effective-directive': 'a'.repeat(500) + '\u0000\n', 'blocked-uri': 'zzz'.repeat(500) } });
    expect(v[0]!.directive.length).toBe(60);
    expect(v[0]!.blocked.length).toBeLessThanOrEqual(40);
  });
});

describe('POST /csp-report', () => {
  it('answers 204 without a session, for both report content types', async () => {
    await request(app.getHttpServer()).post(`${API}/csp-report`).set('Content-Type', 'application/csp-report').send(JSON.stringify(legacy)).expect(204);
    await request(app.getHttpServer()).post(`${API}/csp-report`).set('Content-Type', 'application/reports+json').send(JSON.stringify([{ type: 'csp-violation', body: { effectiveDirective: 'img-src' } }])).expect(204);
  });
  it('is limited per address and refuses a large body', async () => {
    const big = JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(40_000) } });
    const r = await request(app.getHttpServer()).post(`${API}/csp-report`).set('Content-Type', 'application/csp-report').send(big);
    expect(r.status).toBe(413);
    let last = 204;
    for (let i = 0; i < 35; i++) last = (await request(app.getHttpServer()).post(`${API}/csp-report`).set('Content-Type', 'application/csp-report').send(JSON.stringify(legacy))).status;
    expect(last).toBe(429);
  });
  it('does not widen what other routes accept: a CSP content type is not parsed elsewhere', async () => {
    const r = await request(app.getHttpServer()).post(`${API}/auth/local/login`).set('Content-Type', 'application/csp-report').send(JSON.stringify({ identifier: 'a', password: 'b' }));
    expect(r.status).not.toBe(204);
    expect([400, 401, 415, 422, 429]).toContain(r.status);
  });
});
