import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { OpsLimitsDto, OpsLimitsService } from './ops-limits.service';

/** Contract `settings` (migration 0402): GET and PUT /settings/ops-limits, the operational limits. */
@Controller('settings/ops-limits')
export class OpsLimitsController {
  constructor(private readonly svc: OpsLimitsService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<OpsLimitsDto> {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put()
  async set(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<OpsLimitsDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
