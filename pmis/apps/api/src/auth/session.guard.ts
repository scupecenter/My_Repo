import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ProblemException, problems } from '../common/problem';
import { INCOMPLETE_OK_KEY, PUBLIC_KEY } from './decorators';
import { COOKIE_NAME, SessionService, parseCookie } from './session.service';
import { UserStateService } from './user-state.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard. In order: session cookie, idle/absolute/revoked check, user status, sliding touch (not for X-PMIS-Live),
 * CSRF on unsafe methods, then the account gates: must change password (ADR 0012 section 5) and pending assignment (ADR 0002 section 5).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly states: UserStateService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const incompleteOk = this.reflector.getAllAndOverride<boolean>(INCOMPLETE_OK_KEY, targets) === true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const token = parseCookie(req.headers.cookie, COOKIE_NAME);
    if (!token) throw problems.unauthenticated();
    const found = await this.sessions.load(token);
    if (!found) throw problems.unauthenticated('The session has ended. Sign in again.');
    const { session, user } = found;
    if (user.status === 'suspended' || user.status === 'disabled') throw problems.unauthenticated('The session has ended. Sign in again.');

    const live = req.header('x-pmis-live') === '1';

    if (!SAFE_METHODS.has(req.method) && !this.sessions.csrfOk(session, req)) {
      throw new ProblemException(403, 'action_forbidden', { detail: 'The CSRF token is missing or wrong. Send the X-CSRF-Token from GET /auth/session.' });
    }

    if (!live) await this.sessions.touch(session.id);

    const state = await this.states.get(user.id, user.email, user.status);
    req.auth = { session, user, state, ip: req.ip ?? null, live };

    if (!incompleteOk) {
      if (session.authMethod === 'local' && state.mustChange) {
        throw new ProblemException(403, 'password_change_required', { detail: 'Change your password first (POST /auth/local/password).' });
      }
      if (state.pending) {
        throw new ProblemException(403, 'pending_assignment', { detail: 'Your account is waiting for an assignment by an administrator.' });
      }
    }
    return true;
  }
}
