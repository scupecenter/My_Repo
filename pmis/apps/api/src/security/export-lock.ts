import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, switchMap } from 'rxjs';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { ProblemException } from '../common/problem';
import { DbService } from '../db/db.service';

export const EXPORT_ACTION_KEY = 'pmis:export_action';

/** Only requests whose query has `name=value` count as an export (for a route that answers JSON by default and a file on request). */
export interface ExportActionOptions {
  whenQuery?: { name: string; value: string };
}

/**
 * Marks a handler that hands data out of the system as a file (a workbook, CSV, zip or calendar file). While the lock key `disable_export` is on
 * (Settings > Security > Lock keys, migration 0290) the handler is refused with 403 `action_forbidden` and `errors[0].code = export_locked`; nothing runs.
 * Both the start of an export job and the download of a finished one carry it. Blank templates and uploaded documents are not exports of data and do not.
 */
export const ExportAction = (opts: ExportActionOptions = {}) => SetMetadata(EXPORT_ACTION_KEY, opts);

export const EXPORT_LOCKED_DETAIL = 'Export is switched off by a System Admin (Settings > Security > Lock keys).';
export const exportLocked = (): ProblemException =>
  new ProblemException(403, 'action_forbidden', { detail: EXPORT_LOCKED_DETAIL, errors: [{ path: '', code: 'export_locked', message: EXPORT_LOCKED_DETAIL }] });

/** Runs inside the request transaction (registered after TxInterceptor), so the lock is read with the caller's context. */
@Injectable()
export class ExportLockInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly db: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.getAllAndOverride<ExportActionOptions | undefined>(EXPORT_ACTION_KEY, [context.getHandler(), context.getClass()]);
    if (!opts) return next.handle();
    if (opts.whenQuery) {
      const req = context.switchToHttp().getRequest<Request>();
      const v = req.query?.[opts.whenQuery.name];
      if ((Array.isArray(v) ? v[0] : v) !== opts.whenQuery.value) return next.handle();
    }
    return from(this.check()).pipe(switchMap(() => next.handle()));
  }

  private async check(): Promise<void> {
    const rows = await this.db.tx.$queryRaw<{ on: boolean }[]>(Prisma.sql`SELECT security_lock_active('disable_export') AS "on"`);
    if (rows[0]?.on) throw exportLocked();
  }
}
