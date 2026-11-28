import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { QUARANTINE_PREFIX, makeQuarantine, quarantineFiles, thumbKeysFor } from '../src/settings/data-reset-files';

// The quarantine directory of a data reset is named by a stamp of one-second resolution. Two runs in the same second (seen in CI after #211)
// made the second one fail with 409 quarantine_unavailable: the name must be unique, and an existing directory never reused.
describe('makeQuarantine: a unique directory per run', () => {
  const store = mkdtempSync(join(tmpdir(), 'pmis-quar-store-'));
  afterAll(() => rmSync(store, { recursive: true, force: true }));

  it('two runs with the same stamp get two different, new directories', async () => {
    const a = await makeQuarantine(store, '20261125-083000');
    const b = await makeQuarantine(store, '20261125-083000');
    const c = await makeQuarantine(store, '20261125-083000');
    expect(new Set([a, b, c]).size).toBe(3);
    expect(basename(a)).toBe(`${QUARANTINE_PREFIX}20261125-083000`);
    expect(basename(b)).toBe(`${QUARANTINE_PREFIX}20261125-083000-2`);
    expect(basename(c)).toBe(`${QUARANTINE_PREFIX}20261125-083000-3`);
    for (const d of [a, b, c]) expect(existsSync(d)).toBe(true);
  });
});

describe('thumbnails follow their originals into the quarantine', () => {
  const store = mkdtempSync(join(tmpdir(), 'pmis-quar-thumbs-'));
  afterAll(() => rmSync(store, { recursive: true, force: true }));

  it('finds every size and format of a source, and moves them, whatever the size setting was', async () => {
    const key = 'docs/2026/11/abc123';
    mkdirSync(join(store, 'docs/2026/11'), { recursive: true });
    mkdirSync(join(store, 'thumbs/2026/11'), { recursive: true });
    writeFileSync(join(store, key), 'x');
    for (const n of ['abc123-s240-webp', 'abc123-m640-jpeg', 'abc123-s100-webp', 'other-s240-webp']) writeFileSync(join(store, 'thumbs/2026/11', n), 't');
    const found = (await thumbKeysFor(store, [key])).sort();
    expect(found).toEqual(['thumbs/2026/11/abc123-m640-jpeg', 'thumbs/2026/11/abc123-s100-webp', 'thumbs/2026/11/abc123-s240-webp']);
    const q = await makeQuarantine(store);
    const out = await quarantineFiles(store, q, found);
    expect(out.every((o) => o.outcome === 'moved')).toBe(true);
    expect(existsSync(join(store, 'thumbs/2026/11/other-s240-webp'))).toBe(true);
    expect(existsSync(join(store, 'thumbs/2026/11/abc123-s240-webp'))).toBe(false);
  });
});
