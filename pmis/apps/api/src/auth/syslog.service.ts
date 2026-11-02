import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DbService } from '../db/db.service';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** System Log writer (table system_log). Never throws: a logging failure must not break a request. */
@Injectable()
export class SyslogService {
  private readonly log = new Logger('Syslog');

  constructor(private readonly db: DbService) {}

  /**
   * Writes through the ambient request transaction when there is one (so a rolled-back request leaves no row),
   * otherwise through its own autocommit statement.
   */
  async write(level: LogLevel, message: string, context: Record<string, unknown> = {}, userId?: string, requestId?: string, source = 'api'): Promise<void> {
    try {
      const json = JSON.stringify(context);
      // migration 0045: pmis_app cannot insert into system_log; log_system_write (owner pmis_definer) does
      await this.db.tx.$executeRaw(Prisma.sql`SELECT log_system_write(${level}::text, ${source}::text, ${message}::text, ${json}::jsonb, ${userId ?? null}::uuid, ${requestId ?? null}::text)`);
    } catch (e) {
      this.log.warn(`system log write failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
    }
  }
}
