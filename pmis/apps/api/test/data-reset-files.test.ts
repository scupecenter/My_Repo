import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { QUARANTINE_PREFIX, makeQuarantine } from '../src/settings/data-reset-files';

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
