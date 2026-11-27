import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, finalize } from 'rxjs';

type Json = Record<string, unknown>;
interface Entry { at: number; value: Json }

/**
 * A short, in-process cache of the heavy part of GET /dashboard (the dash_overview call). It is not a shared store: each API process keeps its own.
 *
 * What makes an entry safe to share: the key is built by the caller from everything the result depends on (the caller's dashboard and issues
 * region scope read live on every request, the filters, the view, the override flag, the resolved site set of the filter tree). So a rights, role or
 * delegation change takes effect on the next request and an entry can never serve another scope. The rights check itself runs on every request,
 * before the cache is asked.
 *
 * Staleness (stated in the docs): task and register data changes show within the TTL (30 s by default); a change to settings, goals, weights,
 * calendars, SLA rules, delay periods, imports or a data reset clears the cache at once (DashboardCacheInvalidator). DASHBOARD_CACHE_TTL_MS=0 turns it off.
 */
@Injectable()
export class DashboardCacheService {
  private readonly ttl = Math.max(0, Number(process.env.DASHBOARD_CACHE_TTL_MS ?? 30_000) || 0);
  private readonly max = 200;
  private readonly entries = new Map<string, Entry>();
  private readonly flying = new Map<string, Promise<Entry>>();
  private generation = 0;

  /** The cached value for `key`, or the one run of `load` that every concurrent caller of the same key shares. `computedAt` is when the figures were read. */
  async getOrLoad(key: string, load: () => Promise<Json>): Promise<{ value: Json; computedAt: Date }> {
    if (this.ttl === 0) return { value: await load(), computedAt: new Date() };
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.at < this.ttl) return { value: structuredClone(hit.value), computedAt: new Date(hit.at) };
    if (hit) this.entries.delete(key);
    let run = this.flying.get(key);
    if (!run) {
      const gen = this.generation;
      run = (async (): Promise<Entry> => {
        const entry: Entry = { at: Date.now(), value: await load() };
        // A clear() that happened while this load ran means the figures may predate the change: serve them to the waiting callers, never keep them.
        if (gen === this.generation) {
          this.entries.set(key, entry);
          while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
        }
        return entry;
      })().finally(() => {
        this.flying.delete(key);
      });
      this.flying.set(key, run);
    }
    const e = await run;
    return { value: structuredClone(e.value), computedAt: new Date(e.at) };
  }

  /** Drops every entry, and keeps the loads that are running from storing their result. */
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.flying.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

/** The requests whose success changes what the dashboard computes from configuration (not from task rows): they clear the cache once they have committed. */
const CLEARING = /^\/api\/v1\/(settings|dashboard|goals|weights|workflow|matrix|roles|delegations|regions|master-import|import-batches|data-hub|templates|custom-fields|list-catalogues)(\/|\?|$)|^\/api\/v1\/tasks\/[^/]+\/delay-periods/;

/** Registered before TxInterceptor, so it runs after the request's transaction has committed. */
@Injectable()
export class DashboardCacheInvalidator implements NestInterceptor {
  constructor(private readonly cache: DashboardCacheService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ method: string; originalUrl?: string; url: string }>();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next.handle();
    const url = req.originalUrl ?? req.url;
    if (!CLEARING.test(url)) return next.handle();
    return next.handle().pipe(finalize(() => this.cache.clear()));
  }
}
