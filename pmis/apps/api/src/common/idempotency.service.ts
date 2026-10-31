import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { problems } from './problem';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const KEY_PATTERN = /^[\x21-\x7e]{8,128}$/;

interface Entry {
  hash: string;
  at: number;
  result: Promise<unknown>;
}

/**
 * Idempotency-Key (contract conventions): a replay of the same request within 24 hours returns the first response.
 *
 * The entries are kept in this process. A restart, or a second API instance, forgets them; the database has no table for
 * them yet (see the report). A key is scoped to the signed-in user and the operation, and is bound to the request body:
 * the same key with another body is 422. A failed request is not remembered, so the client can retry it.
 */
@Injectable()
export class IdempotencyService {
  private readonly entries = new Map<string, Entry>();

  async run<T>(userId: string, operation: string, key: string | undefined, body: unknown, fn: () => Promise<T>): Promise<T> {
    if (key === undefined) return fn();
    if (!KEY_PATTERN.test(key)) {
      throw problems.validation([{ path: 'Idempotency-Key', code: 'invalid', message: 'Use 8 to 128 printable characters without spaces.' }]);
    }
    this.sweep();
    const id = `${userId}|${operation}|${key}`;
    const hash = createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
    const seen = this.entries.get(id);
    if (seen) {
      if (seen.hash !== hash) {
        throw problems.validation([{ path: 'Idempotency-Key', code: 'key_reused', message: 'This key was used for a different request body.' }]);
      }
      return (await seen.result) as T;
    }
    const result = fn();
    const entry: Entry = { hash, at: Date.now(), result };
    this.entries.set(id, entry);
    try {
      return await result;
    } catch (e) {
      if (this.entries.get(id) === entry) this.entries.delete(id);
      throw e;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (now - v.at > TTL_MS || this.entries.size > MAX_ENTRIES) this.entries.delete(k);
    }
  }
}
