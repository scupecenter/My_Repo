import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_API_AUTH_USERS } from './realApi';

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
      const base = /@Controller\(\s*'([^']*)'\s*\)/.exec(block)?.[1];
      if (base === undefined) continue;
      for (const m of block.matchAll(/@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/g)) {
        const path = '/' + [base, m[2] ?? ''].map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
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
});
