import { describe, expect, it } from 'vitest';
import { ProblemFilter } from '../src/common/problem.filter';

/** The System Log row of an unexpected error names an operating-system cause (owner request 2026-11-10), never the free text of other errors. */
function run(e: unknown): Record<string, unknown> {
  const rows: Record<string, unknown>[] = [];
  const syslog = { write: async (_l: string, _m: string, ctx: Record<string, unknown>) => { rows.push(ctx); } };
  const res: any = { getHeader: () => 'req-1', status() { return this; }, setHeader() { return this; }, type() { return this; }, json() { return this; }, send() { return this; }, end() { return this; } };
  const req: any = { method: 'POST', originalUrl: '/api/v1/master-import/runs', route: { path: '/api/v1/master-import/runs' }, id: 'req-1', headers: {} };
  const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) };
  new ProblemFilter(syslog as never).catch(e, host);
  return rows[0]!;
}

describe('ProblemFilter: the System Log row of an unexpected error', () => {
  it('keeps the code, the call and the path of an operating-system error', () => {
    const e = Object.assign(new Error("EACCES: permission denied, mkdir '/var/lib/gsdn-pmis/files/imports/2026/11'"), { code: 'EACCES', syscall: 'mkdir', path: '/var/lib/gsdn-pmis/files/imports/2026/11' });
    expect(run(e)).toMatchObject({ name: 'Error', code: 'EACCES', syscall: 'mkdir', path: '/var/lib/gsdn-pmis/files/imports/2026/11', route: 'POST /api/v1/master-import/runs' });
  });
  it('stores no free text for another error', () => {
    const row = run(new Error('value 0910000001 is wrong'));
    expect(row).toEqual({ name: 'Error', route: 'POST /api/v1/master-import/runs' });
  });
});
