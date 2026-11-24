import { Injectable } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DbService } from '../db/db.service';

/** Routes answered while a project data reset runs: the runner follows the progress (contract 0.15.62, "Maintenance"). */
const OPEN_DURING_RESET: RegExp[] = [
  /^\/api\/v1\/settings\/data-reset\/?$/,
  /^\/api\/v1\/settings\/data-reset\/requests\/[0-9a-fA-F-]{36}\/?$/,
  /^\/api\/v1\/auth\/session\/?$/,
  /^\/api\/v1\/health(\/.*)?$/,
];
const CHECK_EVERY_MS = 1000;

/**
 * Maintenance mode of the project data reset (migration 0146). While a reset's database transaction is open, every route except the reads above answers 503
 * `maintenance`. Two sources: this process's own run (set by DataResetService at once), and the database (`data_reset_maintenance()`: a request in
 * `running` or the advisory lock of a reset held, e.g. by another API process), read at most once a second.
 */
@Injectable()
export class MaintenanceService {
  private own = 0;
  private cached: { at: number; on: boolean } = { at: 0, on: false };
  private inFlight = 0;

  constructor(private readonly db: DbService) {}

  begin(): void {
    this.own += 1;
  }

  end(): void {
    this.own = Math.max(0, this.own - 1);
    this.cached = { at: 0, on: false };
  }

  async active(): Promise<boolean> {
    if (this.own > 0) return true;
    if (Date.now() - this.cached.at < CHECK_EVERY_MS) return this.cached.on;
    let on = false;
    try {
      const r = await this.db.client.$queryRaw<{ m: boolean }[]>`SELECT data_reset_maintenance() AS m`;
      on = r[0]?.m === true;
    } catch {
      on = false; // the database is down or not migrated: the requests fail on their own
    }
    this.cached = { at: Date.now(), on };
    return on;
  }

  /** Waits until no refused-during-maintenance request of this process is still running (at most `ms`). */
  async drain(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (this.inFlight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  }

  /** Express middleware, before the session guard and the request transaction. */
  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
      const open = req.method === 'GET' && OPEN_DURING_RESET.some((re) => re.test(path));
      if (open || !path.startsWith('/api/v1/')) {
        next();
        return;
      }
      void this.active().then((on) => {
        if (on) {
          res.status(503).setHeader('Retry-After', '30');
          res.type('application/problem+json').send(JSON.stringify({
            type: 'https://pmis.aljeel.internal/problems/maintenance', title: 'A project data reset is running', status: 503, code: 'maintenance',
            detail: 'A System Admin is resetting the project data. Try again in a few minutes.', request_id: req.id ?? null,
          }));
          return;
        }
        this.inFlight += 1;
        let done = false;
        const fin = () => {
          if (!done) {
            done = true;
            this.inFlight -= 1;
          }
        };
        res.on('finish', fin);
        res.on('close', fin);
        next();
      }, next);
    };
  }
}
