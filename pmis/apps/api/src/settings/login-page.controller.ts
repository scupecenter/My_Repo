import { Body, Controller, Get, Headers, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Public } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { LoginPageDto, LoginPagePublicDto, LoginPageService } from './login-page.service';

/**
 * Contract `settings` (0.15.97, migration 0197): GET and PUT /settings/login-page, the sign-in page settings, and
 * GET /settings/login-page/public, the public read of only what the sign-in page shows. The public route is cached
 * for 30 seconds and rate limited per address; it carries no version, no audit data and nothing about users.
 */
@Controller('settings/login-page')
export class LoginPageController {
  constructor(private readonly svc: LoginPageService) {}

  @Public()
  @Get('public')
  async publicConfig(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LoginPagePublicDto> {
    const r = await this.svc.publicConfig(req.ip ?? null);
    res.setHeader('Cache-Control', 'public, max-age=30');
    return r;
  }

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<LoginPageDto> {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put()
  async set(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<LoginPageDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
