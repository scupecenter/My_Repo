import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Public } from '../auth/decorators';
import { DbService } from '../db/db.service';
import { MailService } from './mail.service';

/** Mail delivery for the admins (contract 0.12.3, tag `system`). */
@Controller('admin/mail')
export class MailController {
  constructor(private readonly mail: MailService) {}

  @Get('status')
  status() {
    return this.mail.status();
  }

  @Post('test')
  @HttpCode(200)
  test(@Auth() auth: AuthContext) {
    return this.mail.test(auth);
  }

  @Get('outbox')
  outbox(@Query() q: Record<string, unknown>) {
    return this.mail.outbox(q);
  }

  @Post('outbox/:id/retry')
  @HttpCode(200)
  retry(@Param('id') id: string, @Body() body: unknown) {
    return this.mail.retry(id, body);
  }
}

/**
 * The external monitoring path (owner answer Q167): `GET /health`, no session, words only (no counts, no names, no addresses), so a monitor outside the
 * PMIS (Zabbix, Uptime Kuma, a cron with curl) can raise its own alarm when the PMIS or its mail is down. 200 when the database answers, 503 otherwise.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService, private readonly mail: MailService) {}

  @Public()
  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const h = (await this.db.client.$queryRaw<{ j: { jobs_failed_24h: number; integrity: Record<string, { status: string | null }>; alerts_ran_at: string | null } }[]>(
        Prisma.sql`SELECT log_health() AS j`))[0]!.j;
      const mail = await this.mail.healthWord().catch(() => 'failing' as const);
      const integ = Object.values(h.integrity ?? {}).map((x) => x?.status ?? null);
      const integrity = integ.includes('broken') ? 'broken' : integ.length > 0 && integ.every((x) => x === 'ok') ? 'ok' : 'unknown';
      const jobs = Number(h.jobs_failed_24h ?? 0) > 0 ? 'failing' : 'ok';
      const degraded = mail === 'failing' || integrity === 'broken' || jobs === 'failing';
      return { status: degraded ? 'degraded' : 'ok', checks: { database: 'ok', mail, integrity, jobs } };
    } catch {
      res.status(503);
      return { status: 'down', checks: { database: 'down', mail: 'unknown', integrity: 'unknown', jobs: 'unknown' } };
    }
  }
}
