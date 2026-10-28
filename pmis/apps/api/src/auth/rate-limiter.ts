import { Injectable } from '@nestjs/common';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** In-memory sliding window per key. One process only (the API runs as one service on one server). */
@Injectable()
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
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

  reset(): void {
    this.hits.clear();
  }

  private sweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < windowMs && this.hits.size < 10_000) return;
    this.lastSweep = now;
    for (const [k, list] of this.hits) {
      if (list.length === 0 || now - (list[list.length - 1] ?? 0) >= windowMs) this.hits.delete(k);
    }
  }
}
