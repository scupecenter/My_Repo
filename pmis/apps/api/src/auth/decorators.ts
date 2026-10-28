import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthContext } from './auth.types';
import { ProblemException } from '../common/problem';

export const PUBLIC_KEY = 'pmis:public';
export const INCOMPLETE_OK_KEY = 'pmis:incomplete_ok';

/** No session needed (sign-in itself). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Reachable by a pending account and by an account that must change its password (/auth/*, GET /me, and the blocking announcement pop-up: GET /me/announcements/pending and POST /announcements/{id}/respond). */
export const AllowIncomplete = () => SetMetadata(INCOMPLETE_OK_KEY, true);

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
  if (!req.auth) throw new ProblemException(401, 'unauthenticated', {});
  return req.auth;
});
