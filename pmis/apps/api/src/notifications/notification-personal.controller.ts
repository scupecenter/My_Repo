import { Body, Controller, Get, Headers, HttpCode, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader, parseIfMatch } from '../common/etag';
import { NotificationPersonalService } from './notification-personal.service';

type Json = Record<string, unknown>;

/** Personal notification settings (contract 0.15.531, tag notifications): a person manages only their own; the org switches are System Admin only. */
@Controller()
export class NotificationPersonalController {
  constructor(private readonly svc: NotificationPersonalService) {}

  private tag(res: Response, v: Json): Json {
    if (typeof v.version === 'number') res.setHeader('ETag', etagHeader(v.version));
    return v;
  }

  @Get('me/notification-prefs')
  async mine(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.mine(auth));
  }

  @Put('me/notification-prefs')
  async save(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.save(auth, parseIfMatch(ifMatch), body));
  }

  @Post('me/notification-prefs/snooze')
  @HttpCode(200)
  async snooze(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.snooze(auth, body));
  }

  @Post('me/notification-prefs/test')
  @HttpCode(200)
  test(@Auth() auth: AuthContext) {
    return this.svc.test(auth);
  }

  @Get('me/notification-prefs/decisions')
  decisions(@Auth() auth: AuthContext) {
    return this.svc.decisions(auth);
  }

  @Get('admin/notification-personal')
  async org(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.org(auth));
  }

  @Put('admin/notification-personal')
  async saveOrg(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.saveOrg(auth, parseIfMatch(ifMatch), body));
  }
}
