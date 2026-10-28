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
  async write(level: LogLevel, message: string, context: Record<string, unknown> = {}, userId?: string, requestId?: string): Promise<void> {
    try {
      const json = JSON.stringify(context);
      await this.db.tx.$executeRaw(Prisma.sql`INSERT INTO system_log (level, source, message, context, user_id, request_id)
        VALUES (${level}::"LogLevel", 'api', ${message}, ${json}::jsonb, ${userId ?? null}::uuid, ${requestId ?? null})`);
    } catch (e) {
      this.log.warn(`system log write failed: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
    }
  }
}
