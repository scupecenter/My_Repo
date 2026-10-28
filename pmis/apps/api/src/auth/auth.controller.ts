import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemException, problems } from '../common/problem';
import { AuthService, SessionBody } from './auth.service';
import type { AuthContext } from './auth.types';
import { AllowIncomplete, Auth, Public } from './decorators';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('local/login')
  @HttpCode(200)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown): Promise<SessionBody> {
    if (!req.is('application/json')) throw problems.badRequest('Send the request as Content-Type: application/json.');
    const { token, body: session } = await this.auth.login(body, req.ip ?? null, req.header('user-agent'), req.id ?? '');
    this.sessions.setCookie(res, token);
    return session;
  }

  @AllowIncomplete()
  @Get('session')
  session(@Auth() auth: AuthContext): Promise<SessionBody> {
    return this.auth.sessionBody(auth);
  }

  @AllowIncomplete()
  @Post('logout')
  @HttpCode(204)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(auth);
    this.sessions.clearCookie(res);
  }

  @AllowIncomplete()
  @Post('local/password')
  @HttpCode(200)
  password(@Auth() auth: AuthContext, @Body() body: unknown): Promise<SessionBody> {
    this.needLocal(auth);
    return this.auth.changePassword(auth, body);
  }

  @AllowIncomplete()
  @Post('local/step-up')
  @HttpCode(200)
  stepUp(@Auth() auth: AuthContext, @Body() body: unknown): Promise<SessionBody> {
    this.needLocal(auth);
    return this.auth.localStepUp(auth, body);
  }

  private needLocal(auth: AuthContext): void {
    if (auth.session.authMethod !== 'local') {
      throw new ProblemException(403, 'action_forbidden', { detail: 'This session did not sign in with a local password.' });
    }
  }
}
