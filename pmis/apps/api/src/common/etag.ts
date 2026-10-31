import { createHash } from 'node:crypto';
import { ProblemException } from './problem';

export const etagHeader = (version: number | string): string => `"${version}"`;

/** An integer version derived from content (for resources without a version column). 48 bits, safe in JSON. */
export function contentVersion(value: unknown): number {
  const h = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
  return parseInt(h, 16);
}

/** If-Match: missing is 428, a stale or malformed value is 412. `*` matches any current version. */
export function checkIfMatch(header: string | undefined, current: number | string): void {
  if (header === undefined || header.trim() === '') {
    throw new ProblemException(428, 'precondition_required', { detail: 'Send the ETag you last read in If-Match.' });
  }
  if (header.trim() === '*') return;
  const wanted = header.split(',').map((s) => s.trim().replace(/^W\//, '').replace(/^"|"$/g, ''));
  if (!wanted.includes(String(current))) {
    throw new ProblemException(412, 'precondition_failed', { detail: 'The resource changed since you read it. Reload and try again.' });
  }
}

/**
 * If-Match for a mutation that hands the version to the database: missing is 428, `*` means any version (null), a malformed or
 * non-numeric value is 412 (it cannot match any version).
 */
export function parseIfMatch(header: string | undefined): number | null {
  if (header === undefined || header.trim() === '') {
    throw new ProblemException(428, 'precondition_required', { detail: 'Send the ETag you last read in If-Match.' });
  }
  if (header.trim() === '*') return null;
  const first = header.split(',')[0]?.trim().replace(/^W\//, '').replace(/^"|"$/g, '') ?? '';
  if (!/^[0-9]{1,9}$/.test(first)) throw new ProblemException(412, 'precondition_failed', { detail: 'The If-Match value does not match any version.' });
  return Number(first);
}
