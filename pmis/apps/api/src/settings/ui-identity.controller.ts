import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { UiIdentityDto, UiIdentityService } from './ui-identity.service';

/** Contract `settings` (0.15.41, migration 0130): GET and PUT /settings/identity, the organization default UI design. */
@Controller('settings/identity')
export class UiIdentityController {
  constructor(private readonly svc: UiIdentityService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<UiIdentityDto> {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put()
  async set(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<UiIdentityDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
