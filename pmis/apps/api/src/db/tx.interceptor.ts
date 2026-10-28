import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, lastValueFrom } from 'rxjs';
import { DbService } from './db.service';
import type { AuthContext } from '../auth/auth.types';
import { ProblemException } from '../common/problem';

type Outcome = { ok: true; value: unknown } | { ok: false; error: ProblemException };

/**
 * One transaction per authenticated request. The first statements are set_config('app.user_id') and
 * set_config('app.region_ids') (transaction-local), so the database functions and row-level security know who acts.
 * A ProblemException with commit=true (a wrong password that must count toward the lockout) commits first, then is thrown.
 */
@Injectable()
export class TxInterceptor implements NestInterceptor {
  constructor(private readonly db: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ auth?: AuthContext }>();
    const auth = req.auth;
    if (!auth) return next.handle();
    return from(this.run(auth, next));
  }

  private async run(auth: AuthContext, next: CallHandler): Promise<unknown> {
    const outcome: Outcome = await this.db.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.user_id', ${auth.user.id}, true)`;
        // System Admins see every region. Others get the union of their active assignments (empty = nothing, ADR 0003).
        await tx.$queryRaw`SELECT set_config('app.region_ids',
          CASE WHEN ${auth.state.isAdmin}::boolean THEN '*' ELSE app_resolve_region_ids(${auth.user.id}::uuid) END, true)`;
        return this.db.runIn(tx, async (): Promise<Outcome> => {
          try {
            return { ok: true, value: await lastValueFrom(next.handle(), { defaultValue: undefined }) };
          } catch (e) {
            if (e instanceof ProblemException && e.commit) return { ok: false, error: e };
            throw e;
          }
        });
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
