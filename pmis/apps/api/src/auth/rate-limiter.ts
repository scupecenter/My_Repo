import { Injectable } from '@nestjs/common';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** In-memory sliding window per key. One process only (the API runs as one service on one server). */
@Injectable()
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly fails = new Map<string, number[]>();
  /** Attempts that passed progressiveWait and have not finished yet: they count as failures until they end, so parallel attempts cannot all pass. */
  private readonly inflight = new Map<string, number>();
  private clock: Clock = systemClock;
  private lastSweep = 0;

  setClock(clock: Clock): void {
    this.clock = clock;
  }

  /**
   * Records an attempt and says whether it is allowed. Returns 0 when allowed, otherwise the seconds to wait.
   * Rejected attempts are not recorded, so a client that keeps trying does not extend its own block.
   */
  hit(key: string, limit: number, windowMs = 60_000): number {
    const now = this.clock.now();
    this.sweep(now, windowMs);
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit) {
      this.hits.set(key, list);
      const oldest = list[0] ?? now;
      return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }

  /**
   * Progressive limiting (owner answer Q168): many people may sign in from one address behind NAT, so an address is never blocked for long. Only
   * failures count. The first `free` failures inside `windowMs` pass; after that every attempt waits `baseSec * 2^(n - free)` seconds after the last
   * failure, at most `maxSec`. Returns 0 when the attempt may go ahead, otherwise the seconds to wait. Does not record anything.
   */
  progressiveWait(key: string, free: number, windowMs: number, baseSec: number, maxSec: number): number {
    const now = this.clock.now();
    const list = (this.fails.get(key) ?? []).filter((t) => now - t < windowMs);
    const pending = this.inflight.get(key) ?? 0;
    const n = list.length + pending;
    if (n < free) return 0;
    const last = pending > 0 ? now : (list[list.length - 1] ?? now);
    const wait = Math.min(maxSec, baseSec * 2 ** Math.min(30, n - free)) * 1000;
    const left = last + wait - now;
    return left > 0 ? Math.max(1, Math.ceil(left / 1000)) : 0;
  }

  /**
   * Reserves a slot for an attempt that passed progressiveWait, synchronously, before any await: until the returned release runs, the attempt counts
   * as a failure. Call release once the attempt ends (after progressiveFail when it failed). Release is idempotent.
   */
  progressiveBegin(key: string): () => void {
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.inflight.get(key) ?? 1) - 1;
      if (left > 0) this.inflight.set(key, left);
      else this.inflight.delete(key);
    };
  }

  /** Records a failure for progressiveWait. */
  progressiveFail(key: string, windowMs: number): void {
    const now = this.clock.now();
    const list = (this.fails.get(key) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    this.fails.set(key, list.slice(-1000));
    if (this.fails.size > 10_000) {
      for (const [k, l] of this.fails) if (l.length === 0 || now - (l[l.length - 1] ?? 0) >= windowMs) this.fails.delete(k);
    }
  }

  reset(): void {
    this.hits.clear();
    this.fails.clear();
    this.inflight.clear();
  }

  private sweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < windowMs && this.hits.size < 10_000) return;
    this.lastSweep = now;
    for (const [k, list] of this.hits) {
      if (list.length === 0 || now - (list[list.length - 1] ?? 0) >= windowMs) this.hits.delete(k);
    }
  }
}
