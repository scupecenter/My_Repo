/**
 * Maintenance command for stored files (owner answer Q134). Run from the installed tree, as the API user, with the same environment as the API:
 *
 *   node dist/documents/storage-cli.js encrypt-legacy [--dry-run]   one-off: encrypt the plaintext objects that have no envelope (idempotent)
 *   node dist/documents/storage-cli.js rewrap                       key rotation: rewrap the data keys under FILE_ENC_KEY_ID (content untouched)
 *   node dist/documents/storage-cli.js rescan                       scan the files flagged pending_rescan now
 *   node dist/documents/storage-cli.js purge-exports                delete the stored zip exports past expires_at now
 *   node dist/documents/storage-cli.js verify                       decrypt every stored object and compare SHA-256 and size (restore drill)
 *
 * Exit 0 = the step finished (failures are printed; a non-zero `failed` count exits 1). The runbook is infra/RUNBOOK.md.
 */
import { loadConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { purgeExpiredExports, encryptLegacyObjects, rescanPending, rewrapKeys, verifyStored } from './storage-maintenance';
import { DbMetaStore, ProtectedStorage, scannerFor, storageFor } from './storage.service';

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const dryRun = argv.includes('--dry-run');
  if (!['encrypt-legacy', 'rewrap', 'rescan', 'purge-exports', 'verify'].includes(cmd ?? '')) {
    console.error('usage: storage-cli.js encrypt-legacy [--dry-run] | rewrap | rescan | purge-exports | verify');
    return 2;
  }
  const config = loadConfig();
  const db = new DbService(config);
  try {
    const meta = new DbMetaStore(db);
    const store = new ProtectedStorage(storageFor(config.storage), meta, config.fileEnc, scannerFor(config.scan), config.scan.onFailure, {
      log: async (level, message, context) => {
        process.stdout.write(`[${level}] ${message} ${JSON.stringify(context)}\n`);
      },
    });
    if (cmd === 'encrypt-legacy') {
      const r = await encryptLegacyObjects(meta, store, { dryRun, onProgress: (l) => process.stdout.write(`${l}\n`) });
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return r.failed + r.mismatch > 0 ? 1 : 0;
    }
    if (cmd === 'rewrap') {
      let total = { done: 0, failed: 0 };
      for (;;) {
        const r = await rewrapKeys(store);
        total = { done: total.done + r.done, failed: total.failed + r.failed };
        if (r.done === 0) break;
      }
      process.stdout.write(`${JSON.stringify(total)}\n`);
      return total.failed > 0 ? 1 : 0;
    }
    if (cmd === 'rescan') {
      const r = await rescanPending(meta, store);
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return r.failed > 0 ? 1 : 0;
    }
    if (cmd === 'verify') {
      const r = await verifyStored(meta, store, (l) => process.stdout.write(`${l}\n`));
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return r.bad > 0 ? 1 : 0;
    }
    const r = await purgeExpiredExports(meta, store);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return r.failed > 0 ? 1 : 0;
  } finally {
    await db.client.$disconnect();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`storage-cli: ${e instanceof Error ? e.message.split('\n')[0] : 'failed'}`);
    process.exit(1);
  },
);
