import { describe, expect, it } from 'vitest';
import type { DbService } from '../src/db/db.service';
import { MaintenanceService, normalisePath } from '../src/settings/maintenance.service';

/**
 * The maintenance mode of the project data reset (migration 0146) must refuse every API route during a run, whatever the spelling of the path:
 * Express routes case-insensitively and decodes percent-escapes, so a check on the raw text could be bypassed.
 */
describe('maintenance mode: the path check cannot be bypassed by spelling', () => {
  it('normalises case, percent-escapes, backslashes and repeated slashes', () => {
    expect(normalisePath('/API/V1/Users?x=1')).toBe('/api/v1/users');
    expect(normalisePath('/api/v1/%55sers')).toBe('/api/v1/users');
    expect(normalisePath('//api//v1///users')).toBe('/api/v1/users');
    expect(normalisePath('/api/v1\\users')).toBe('/api/v1/users');
    expect(normalisePath('/api/v1/%E0%A4%A')).toBe('/api/v1/%e0%a4%a'); // an invalid escape keeps the raw text
  });

  const run = async (method: string, url: string): Promise<number> => {
    const svc = new MaintenanceService({} as DbService);
    svc.begin(); // this process runs a reset: no database read needed
    let status = 0;
    const res = {
      status(s: number) { status = s; return this; },
      setHeader() { return this; },
      type() { return this; },
      send() { return this; },
      on() { return this; },
    };
    await new Promise<void>((done) => {
      svc.middleware()({ method, originalUrl: url, url, id: 'r' } as never, res as never, () => { status = 200; done(); });
      setTimeout(done, 50);
    });
    return status;
  };

  it('refuses every API route during a run, in any spelling', async () => {
    for (const u of ['/api/v1/users', '/API/v1/users', '/api/V1/sites', '/api/v1/%73ites', '//api/v1/sites', '/api/v2/anything',
      '/api/v1/settings/data-reset/../../users', '/api/v1/health/../users']) {
      expect(await run('GET', u), u).toBe(503);
    }
    expect(await run('POST', '/api/v1/settings/data-reset')).toBe(503); // only the reads stay open
  });

  it('keeps the progress reads, the session and the health check open', async () => {
    for (const u of ['/api/v1/settings/data-reset', '/API/V1/Settings/Data-Reset', '/api/v1/auth/session', '/api/v1/health',
      '/api/v1/settings/data-reset/requests/00000000-0000-4000-8000-000000000001']) {
      expect(await run('GET', u), u).toBe(200);
    }
  });
});
