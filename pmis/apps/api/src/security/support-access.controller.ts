import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import type { DelegationDto } from '../delegations/delegations.service';
import { etagHeader } from '../common/etag';
import { SupportAccessService, SupportAccessSettingDto } from './support-access.service';

/** Contract `settings` (0.15.191, migration 0291): the support access setting and the support grants (System Admin only). */
@Controller()
export class SupportAccessController {
  constructor(private readonly svc: SupportAccessService) {}

  @Get('settings/support-access')
  async getSetting(@Res({ passthrough: true }) res: Response): Promise<SupportAccessSettingDto> {
    const r = await this.svc.getSetting();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('settings/support-access')
  async setSetting(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<SupportAccessSettingDto> {
    const r = await this.svc.setSetting(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get('support-access')
  list(): Promise<{ items: DelegationDto[] }> {
    return this.svc.list();
  }

  @Post('support-access')
  @HttpCode(201)
  grant(@Auth() auth: AuthContext, @Body() body: unknown): Promise<DelegationDto> {
    return this.svc.grant(auth, body);
  }

  @Post('support-access/revoke-all')
  @HttpCode(200)
  revokeAll(@Auth() auth: AuthContext, @Body() body: unknown): Promise<{ revoked: number }> {
    return this.svc.revokeAll(auth, body);
  }

  @Post('support-access/:id/revoke')
  @HttpCode(200)
  revoke(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<DelegationDto> {
    return this.svc.revoke(auth, id, body);
  }
}
