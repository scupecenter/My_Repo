import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service';
import { DbMetaStore, type Envelope } from '../src/documents/storage.service';
import { testConfig } from './helpers';

/** The envelope functions of migration 0048, called as the application role (pmis_app), which has no direct access to the table. */
describe('stored_object_meta through the storage_* functions (migration 0048)', () => {
  const db = new DbService(testConfig());
  afterAll(async () => {
    await db.client.$disconnect();
  });

  it('put, get, scan verdicts (an infected file stays infected), rewrap, list and delete', async () => {
    const m = new DbMetaStore(db);
    const key = `docs/2026/11/${randomUUID()}`;
    const row: Envelope = {
      storage_key: key, driver: 'local', key_id: 'k1', wrapped_key: Buffer.alloc(60, 1), nonce: Buffer.alloc(12, 2), tag: Buffer.alloc(16, 3),
      plain_sha256: 'a'.repeat(64), size_bytes: 5, scan_status: 'pending_rescan',
    };
    await m.put(row, false);
    const got = await m.get(key);
    expect(got?.scan_status).toBe('pending_rescan');
    expect(got?.wrapped_key.length).toBe(60);
    expect(got?.tag.equals(Buffer.alloc(16, 3))).toBe(true);
    expect(await m.pending(500)).toContain(key);

    await m.setScan(key, 'infected');
    await m.setScan(key, 'clean');
    expect((await m.get(key))?.scan_status).toBe('infected');

    expect(await m.rewrap(key, 'k1', 'k2', Buffer.alloc(60, 4))).toBe(true);
    expect((await m.get(key))?.key_id).toBe('k2');
    expect((await m.rotationBatch('k2', 1000)).some((r) => r.storage_key === key)).toBe(false);
    expect((await m.list(null, 1000)).some((r) => r.storage_key === key)).toBe(true);

    await expect(m.put(row, false)).rejects.toThrow();     // a second row for the same key is refused outside a re-encrypt
    await expect(m.delete(key)).rejects.toThrow(/quarantined/);   // an infected object's envelope is never deleted
    const clean = `docs/2026/11/${randomUUID()}`;
    await m.put({ ...row, storage_key: clean }, false);
    await m.delete(clean);
    expect(await m.get(clean)).toBeNull();
  });

  it('an infected object stays quarantined: a replace (re-encrypt) can neither clear nor overwrite it, and its envelope cannot be deleted', async () => {
    const m = new DbMetaStore(db);
    const key = `docs/2026/11/${randomUUID()}`;
    const row: Envelope = {
      storage_key: key, driver: 'local', key_id: 'k1', wrapped_key: Buffer.alloc(60, 1), nonce: Buffer.alloc(12, 2), tag: Buffer.alloc(16, 3),
      plain_sha256: 'c'.repeat(64), size_bytes: 7, scan_status: 'pending_rescan',
    };
    await m.put(row, false);
    await m.setScan(key, 'infected');
    await expect(m.put({ ...row, scan_status: 'clean', key_id: 'k9' }, true)).rejects.toThrow(/quarantined/);
    const after = await m.get(key);
    expect(after).toMatchObject({ scan_status: 'infected', key_id: 'k1' });
    await expect(m.delete(key)).rejects.toThrow(/quarantined/);
    expect((await m.get(key))?.scan_status).toBe('infected');
    // a replace of a pending object keeps its scan state (it is never set to clean by a replace)
    const key2 = `docs/2026/11/${randomUUID()}`;
    await m.put({ ...row, storage_key: key2 }, false);
    await m.put({ ...row, storage_key: key2, scan_status: 'clean', key_id: 'k2' }, true);
    expect(await m.get(key2)).toMatchObject({ scan_status: 'pending_rescan', key_id: 'k2' });
  });

  it('a new object cannot be planted as infected or clean through the function', async () => {
    const m = new DbMetaStore(db);
    const row: Envelope = {
      storage_key: `docs/2026/11/${randomUUID()}`, driver: 'local', key_id: 'k1', wrapped_key: Buffer.alloc(60), nonce: Buffer.alloc(12),
      tag: Buffer.alloc(16), plain_sha256: 'b'.repeat(64), size_bytes: 1, scan_status: 'infected',
    };
    await expect(m.put(row, false)).rejects.toThrow(/storage meta/);
  });
});
