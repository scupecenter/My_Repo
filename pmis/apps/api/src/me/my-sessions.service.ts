import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthContext } from '../auth/auth.types';
import { SessionService } from '../auth/session.service';
import { problems } from '../common/problem';
import { uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { parseDevice } from '../logs/context';

/**
 * "My sessions" (contract 0.15.102, no migration): the caller's own live sessions (device, sign-in time, last activity, IP) and ending
 * them. Every query is filtered to the caller's own user id; nobody else's session is ever read or ended here. It only narrows access
 * (no permission, no step-up). The current session is never ended here (use sign out). The ending is audited by the user_sessions trigger.
 */
@Injectable()
export class MySessionsService {
  constructor(private readonly db: DbService, private readonly sessions: SessionService) {}

  async list(auth: AuthContext) {
    const rows = await this.db.tx.$queryRaw<{ id: string; created_at: Date; last_activity_at: Date; auth_method: string; ip: string | null; user_agent: string | null }[]>(Prisma.sql`
      SELECT s.id::text AS id, s.created_at, s.last_activity_at, s.auth_method::text AS auth_method, host(s.ip) AS ip, s.user_agent
      FROM user_sessions s
      WHERE s.user_id = ${auth.user.id}::uuid AND s.revoked_at IS NULL AND s.expires_at > now()
      ORDER BY s.last_activity_at DESC LIMIT 50`);
    return {
      items: rows.map((r) => ({
        session_id: r.id, signed_in_at: r.created_at, last_activity_at: r.last_activity_at, ip: r.ip, device: parseDevice(r.user_agent),
        auth_method: r.auth_method === 'm365' ? 'oidc' : r.auth_method, is_current: r.id === auth.session.id,
      })),
    };
  }

  async end(auth: AuthContext, id: string) {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The session does not exist.');
    if (id === auth.session.id) throw problems.validation([{ path: '/session_id', code: 'own_session', message: 'Use sign out for this device.' }]);
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id::text AS id FROM user_sessions WHERE id = ${id}::uuid AND user_id = ${auth.user.id}::uuid AND revoked_at IS NULL AND expires_at > now()`);
    if (!rows[0]) throw problems.notFound('The session does not exist.');
    await this.sessions.revoke(id, auth.user.id, 'self: my sessions');
    await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('session_revoked', 'user_session', ${id}::text, NULL, ${JSON.stringify({ user_id: auth.user.id, self: true })}::jsonb, 'self')`);
    return { revoked_count: 1 };
  }

  async endOthers(auth: AuthContext) {
    const n = await this.sessions.revokeOthers(auth.user.id, auth.session.id, auth.user.id, 'self: my sessions');
    if (n > 0) {
      await this.db.tx.$queryRaw(Prisma.sql`SELECT log_audit_write('session_revoked', 'user_session', ${auth.user.id}::text, NULL, ${JSON.stringify({ user_id: auth.user.id, self: true, count: n })}::jsonb, 'self')`);
    }
    return { revoked_count: n };
  }
}
