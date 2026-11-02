import type { MetaStore, ProtectedStorage } from './storage.service';

/**
 * The maintenance steps of stored files (owner answer Q134). They are plain functions so that the scheduled jobs
 * (storage-jobs.service.ts) and the one-off command (storage-cli.ts) run the same code. Each step is idempotent: a second run finds nothing to do.
 */

export interface StepResult {
  done: number;
  failed: number;
}

/** Zip exports past expires_at: the stored object is deleted, the envelope removed, and the export row marked purged (the row stays). */
export async function purgeExpiredExports(meta: MetaStore, store: ProtectedStorage, limit = 200): Promise<StepResult> {
  const rows = await meta.expiredExports(limit);
  let done = 0, failed = 0;
  for (const r of rows) {
    try {
      await store.remove(r.storage_key);
      await meta.exportPurged(r.export_id);
      done++;
    } catch {
      failed++;
    }
  }
  return { done, failed };
}

/** Objects stored while clamd was down (SCAN_FAILURE=fail_open): scanned now; clean ones are released, infected ones are quarantined and alerted. */
export async function rescanPending(meta: MetaStore, store: ProtectedStorage, limit = 200): Promise<StepResult & { infected: number; still_pending: number }> {
  const keys = await meta.pending(limit);
  let done = 0, failed = 0, infected = 0, stillPending = 0;
  for (const k of keys) {
    try {
      const status = await store.rescan(k);
      if (status === 'clean') done++;
      else if (status === 'infected') infected++;
      else stillPending++;
    } catch {
      failed++;
    }
  }
  return { done, failed, infected, still_pending: stillPending };
}

/** Key rotation: rewraps the data keys that are not under the active master key. Run again after each batch until `rewrapped` is 0. */
export async function rewrapKeys(store: ProtectedStorage, limit = 200): Promise<StepResult> {
  const r = await store.rewrapBatch(limit);
  return { done: r.rewrapped, failed: r.failed };
}

/** One-off re-encryption of legacy plaintext objects found in the document tables. `dryRun` only counts. */
export async function encryptLegacyObjects(
  meta: MetaStore,
  store: ProtectedStorage,
  opts: { batch?: number; dryRun?: boolean; onProgress?: (line: string) => void } = {},
): Promise<{ encrypted: number; skipped: number; mismatch: number; failed: number; candidates: number }> {
  const out = { encrypted: 0, skipped: 0, mismatch: 0, failed: 0, candidates: 0 };
  for (;;) {
    const batch = await meta.legacyCandidates(opts.batch ?? 50);
    if (batch.length === 0) break;
    out.candidates += batch.length;
    if (opts.dryRun) break;
    let progressed = false;
    for (const c of batch) {
      try {
        const r = await store.encryptLegacy(c.storage_key, c.expected_sha256);
        if (r === 'encrypted') {
          out.encrypted++;
          progressed = true;
        } else if (r === 'skipped') {
          out.skipped++;
        } else {
          out.mismatch++;
          opts.onProgress?.(`MISMATCH ${c.storage_key} (${c.source}): the stored bytes do not match the recorded SHA-256; left as they are`);
        }
      } catch (e) {
        out.failed++;
        opts.onProgress?.(`FAILED ${c.storage_key}: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`);
      }
    }
    // Candidates that stayed legacy (mismatch or failure) would come back forever: stop when a whole batch made no progress.
    if (!progressed) break;
  }
  return out;
}

/** Walks every envelope and checks that the stored object decrypts to the recorded SHA-256 and size (the restore drill). */
export async function verifyStored(meta: MetaStore, store: ProtectedStorage, onProgress?: (line: string) => void): Promise<{ checked: number; bad: number }> {
  let after: string | null = null, checked = 0, bad = 0;
  for (;;) {
    const rows = await meta.list(after, 200);
    if (rows.length === 0) break;
    for (const r of rows) {
      checked++;
      const why = await store.verify(r.storage_key);
      if (why) {
        bad++;
        onProgress?.(`BAD ${r.storage_key}: ${why}`);
      }
    }
    after = rows[rows.length - 1]?.storage_key ?? null;
  }
  return { checked, bad };
}
