import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, lastValueFrom } from 'rxjs';
import { DbService } from './db.service';
import type { AuthContext } from '../auth/auth.types';
import { ProblemException } from '../common/problem';
import { StepUpService } from '../auth/step-up.service';
import { applyContext, contextFromRequest } from '../logs/context';
import type { Request } from 'express';

type Outcome = { ok: true; value: unknown } | { ok: false; error: ProblemException };

/**
 * One transaction per authenticated request. The first statement is app_begin (migration 0069): a signed context naming the user, from which the database
 * derives the regions, admin status and delegation itself, so the database functions and row-level security know who acts.
 * A ProblemException with commit=true (a wrong password that must count toward the lockout) commits first, then is thrown.
 */
@Injectable()
export class TxInterceptor implements NestInterceptor {
  constructor(private readonly db: DbService, private readonly stepUp: StepUpService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
    const auth = req.auth;
    if (!auth) return next.handle();
    return from(this.run(req, auth, next));
  }

  private async run(req: Request, auth: AuthContext, next: CallHandler): Promise<unknown> {
    // Migration 0045: the request context (ip, user agent, request id, session, sign-in method, MFA, step-up, device, via) reaches every audit row.
    const until = await this.stepUp.validUntil(auth);
    const ctx = { ...contextFromRequest(req, auth, until !== null), userId: auth.user.id, stepupUntil: until };
    const outcome: Outcome = await this.db.client.$transaction(
      async (tx) => {
        await applyContext(tx, ctx);
        return this.db.runIn(tx, async (): Promise<Outcome> => {
          try {
            return { ok: true, value: await lastValueFrom(next.handle(), { defaultValue: undefined }) };
          } catch (e) {
            if (e instanceof ProblemException && e.commit) return { ok: false, error: e };
            throw e;
          }
        }, ctx);
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
