import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOT_AVAILABLE, REAL_API_AUTH_USERS } from './realApi';

/**
 * Owner report 2026-11-16: SITE 360, the workflow editor, register columns, holidays, SLA rule sets and search showed sample data on the server, because
 * their API routes were never added to REAL_API_AUTH_USERS and the hybrid build kept answering them from the mocks. Every route a controller of
 * apps/api serves must be passed through to the real server.
 */
const API_SRC = resolve(__dirname, '../../../api/src');

function controllers(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return controllers(p);
    return n.endsWith('.controller.ts') ? [p] : [];
  });
}
const shape = (method: string, path: string) => `${method.toLowerCase()} ${path.replace(/:[A-Za-z_]+/g, ':x')}`;

function apiRoutes(): string[] {
  const out = new Set<string>();
  for (const file of controllers(API_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const block of src.split(/(?=@Controller\()/)) {
      // single or double quotes, and the empty @Controller() (P0 of the 2026-11-17 audit: the first version missed both)
      const head = /@Controller\(\s*(?:(['"])([^'"]*)\1)?\s*\)/.exec(block);
      if (!head) continue;
      const base = head[2] ?? '';
      for (const m of block.matchAll(/@(Get|Post|Patch|Put|Delete)\(\s*(?:(['"])([^'"]*)\2)?\s*\)/g)) {
        const path = '/' + [base, m[3] ?? ''].map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
        out.add(shape(m[1]!, path));
      }
    }
  }
  return [...out].sort();
}

describe('the hybrid build passes every API route to the real server', () => {
  it('lists every route served by a controller of apps/api in REAL_API_AUTH_USERS', () => {
    const real = new Set(REAL_API_AUTH_USERS.map(([m, p]) => shape(m, p)));
    const missing = apiRoutes().filter((r) => !real.has(r));
    expect(missing).toEqual([]);
  });

  it('answers "not available" only for routes no controller serves, and never for a passed-through route', () => {
    const api = new Set(apiRoutes());
    const real = new Set(REAL_API_AUTH_USERS.map(([m, p]) => shape(m, p)));
    const wrong = NOT_AVAILABLE.map(([m, p]) => shape(m, p)).filter((r) => api.has(r) || real.has(r));
    expect(wrong).toEqual([]);
  });
});

describe('a route with no API answers "not available" in hybrid mode', () => {
  it('answers 501 not_available, so the screen shows an error and nothing is saved locally', async () => {
    const { server } = await import('./server');
    const { api, ApiError } = await import('@/api/client');
    const { notAvailableHandlers } = await import('./realApi');
    // the first GET still listed, or (the list is empty since every route is served) a sample route given to the same handler
    const [, path] = NOT_AVAILABLE.find(([m]) => m === 'get') ?? (['get', '/not-built-yet/:id'] as const);
    server.use(...notAvailableHandlers(true, [['get', path]]));
    const err = await api.get(path.replace(/:[A-Za-z_]+/g, '00000000-0000-4000-8000-000000000001')).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(501);
    expect((err as InstanceType<typeof ApiError>).code).toBe('not_available');
  }, 30_000);
});
