import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { RateLimiter } from '../auth/rate-limiter';
import { SyslogService } from '../auth/syslog.service';
import { ProblemException, problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const bodySchema = z.object({ message: z.string().max(500).optional() }).strict();

/** A burst guard in front of the database cooldown (the database decides: me_notify_admins and the setting notify_admins.cooldown_minutes). */
export const NOTIFY_ADMINS_BURST = 5;

/**
 * POST /me/notify-admins (0143, contract notifyAdmins): a signed-in user, typically "Pending assignment", asks the System Admins for an assignment.
 * Plain text only, one request per cooldown, an in-app notice and a mail to every active System Admin, an audit row (me_notify_admins).
 */
@Injectable()
export class NotifyAdminsService {
  constructor(
    private readonly db: DbService,
    private readonly limiter: RateLimiter,
    private readonly syslog: SyslogService,
  ) {}

  async notify(auth: AuthContext, raw: unknown): Promise<void> {
    const body = parse(bodySchema, raw ?? {});
    if (auth.session.authMethod === 'break_glass') throw problems.forbidden('action_forbidden', 'The break-glass account does not ask for an assignment.');
    if (auth.session.authMethod === 'local' && auth.state.mustChange) {
      throw new ProblemException(403, 'password_change_required', { detail: 'Change your password first (POST /auth/local/password).' });
    }
    const wait = this.limiter.hit(`notify-admins:${auth.user.id}`, NOTIFY_ADMINS_BURST, 60 * 60_000);
    if (wait) throw problems.rateLimited(wait);
    const rows = await this.db.tx.$queryRaw<{ n: number }[]>`SELECT me_notify_admins(${body.message ?? null}::text) AS n`;
    await this.syslog.write('info', 'admins_notified', { recipients: rows[0]?.n ?? 0 }, auth.user.id);
  }
}
