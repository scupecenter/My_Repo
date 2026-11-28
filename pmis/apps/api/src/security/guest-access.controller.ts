import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { GuestAccessService, GuestAccessSettingDto, GuestDto } from './guest-access.service';

/** Contract `settings` (0.15.730, migration 0731): the guest access setting and the guest accounts (System Admin only). */
@Controller()
export class GuestAccessController {
  constructor(private readonly svc: GuestAccessService) {}

  @Get('settings/guest-access')
  async getSetting(@Res({ passthrough: true }) res: Response): Promise<GuestAccessSettingDto> {
    const r = await this.svc.getSetting();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('settings/guest-access')
  async setSetting(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<GuestAccessSettingDto> {
    const r = await this.svc.setSetting(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get('guests')
  list(): Promise<{ items: GuestDto[] }> {
    return this.svc.list();
  }

  @Post('guests')
  @HttpCode(201)
  create(@Auth() auth: AuthContext, @Body() body: unknown): Promise<{ guest: GuestDto; temporary_password: string }> {
    return this.svc.create(auth, body);
  }

  @Post('guests/:user_id/expiry')
  @HttpCode(200)
  extend(@Auth() auth: AuthContext, @Param('user_id') id: string, @Body() body: unknown): Promise<GuestDto> {
    return this.svc.extend(auth, id, body);
  }

  @Post('guests/:user_id/end')
  @HttpCode(200)
  end(@Auth() auth: AuthContext, @Param('user_id') id: string, @Body() body: unknown): Promise<GuestDto> {
    return this.svc.end(auth, id, body);
  }
}
