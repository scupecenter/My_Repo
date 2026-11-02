import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemException, problems } from '../common/problem';
import { AuthService, LoginResult, SessionBody } from './auth.service';
import { PendingBody } from './auth.service';
import { TwoFactorService } from './two-factor.service';
import type { AuthContext } from './auth.types';
import { AllowIncomplete, Auth, Public } from './decorators';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  @Public()
  @Post('local/login')
  @HttpCode(200)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown): Promise<SessionBody | PendingBody> {
    if (!req.is('application/json')) throw problems.badRequest('Send the request as Content-Type: application/json.');
    const r: LoginResult = await this.auth.login(body, req.ip ?? null, req.header('user-agent'), req.id ?? '');
    if (r.kind === 'pending') {
      this.twoFactor.setPendingCookie(res, r.token);
      return r.body;
    }
    this.sessions.setCookie(res, r.token);
    return r.body;
  }

  /** Second step of sign-in: the code (or a recovery code) with the pending sign-in cookie. */
  @Public()
  @Post('local/2fa')
  @HttpCode(200)
  async twoFactorSignIn(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown): Promise<SessionBody> {
    this.needJson(req);
    const { token, body: session } = await this.auth.twoFactorSignIn(this.twoFactor.pendingTokenFrom(req), body, req.ip ?? null, req.header('user-agent'), req.id ?? '');
    this.twoFactor.clearPendingCookie(res);
    this.sessions.setCookie(res, token);
    return session;
  }

  @Public()
  @Post('local/2fa/enrol/start')
  @HttpCode(200)
  enrolStart(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown): Promise<Record<string, unknown>> {
    this.needJson(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.auth.enrolStart(this.twoFactor.pendingTokenFrom(req), body, req.ip ?? null, req.id ?? '');
  }

  @Public()
  @Post('local/2fa/enrol/confirm')
  @HttpCode(200)
  async enrolConfirm(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown): Promise<{ session: SessionBody; recovery_codes: string[] }> {
    this.needJson(req);
    res.setHeader('Cache-Control', 'no-store');
    const r = await this.auth.enrolConfirm(this.twoFactor.pendingTokenFrom(req), body, req.ip ?? null, req.header('user-agent'), req.id ?? '');
    this.twoFactor.clearPendingCookie(res);
    this.sessions.setCookie(res, r.token);
    return { session: r.body, recovery_codes: r.recovery_codes };
  }

  @Post('local/2fa/recovery-codes')
  @HttpCode(200)
  recoveryCodes(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response, @Body() body: unknown): Promise<{ recovery_codes: string[]; recovery_codes_remaining: number }> {
    this.needLocal(auth);
    res.setHeader('Cache-Control', 'no-store');
    return this.auth.regenerateRecoveryCodes(auth, body);
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

  private needJson(req: Request): void {
    if (!req.is('application/json')) throw problems.badRequest('Send the request as Content-Type: application/json.');
  }

  private needLocal(auth: AuthContext): void {
    if (auth.session.authMethod !== 'local') {
      throw new ProblemException(403, 'action_forbidden', { detail: 'This session did not sign in with a local password.' });
    }
  }
}
