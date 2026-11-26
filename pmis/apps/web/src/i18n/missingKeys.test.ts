import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from './en.json';
import ar from './ar.json';

/** CI guard: every literal t('a.b') key used in src must exist in en.json and ar.json (a plural key needs the base or its _one/_other form). */
const SRC = join(__dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}
/** A key resolves nested ("a.b.c") or flat inside a level ("a" holding "b.c"), as nav does. */
function has(tree: unknown, key: string): boolean {
  if (typeof tree !== 'object' || tree === null) return false;
  const o = tree as Record<string, unknown>;
  if (key in o) return o[key] !== undefined && typeof o[key] === 'string';
  const parts = key.split('.');
  for (let i = 1; i < parts.length; i++) {
    const head = parts.slice(0, i).join('.');
    if (head in o && has(o[head], parts.slice(i).join('.'))) return true;
  }
  return false;
}
const hasKey = (tree: unknown, key: string) => has(tree, key) || has(tree, `${key}_one`) || has(tree, `${key}_other`);

describe('i18n keys', () => {
  it('every literal t() key without a defaultValue exists in en.json and ar.json', () => {
    const re = /\bt\(\s*(['"`])([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\1\s*(,\s*\{[^}]*\})?\s*\)/g;
    const missing: string[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(re)) {
        if (m[3] && /defaultValue/.test(m[3])) continue;
        const key = m[2]!;
        for (const [name, tree] of [['en', en], ['ar', ar]] as const) {
          if (!hasKey(tree, key)) missing.push(`${name}: ${key} (${f.slice(SRC.length + 1)})`);
        }
      }
    }
    expect([...new Set(missing)].sort()).toEqual([]);
  });
});
