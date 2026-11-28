import { Body, Controller, Get, Headers, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { CapacityPlanDto, CapacityPlanSettingsDto, CapacityService } from './capacity.service';

/** Contract 0.15.595 (migration 0666): GET /capacity/plan (the weekly load per region and skill), GET and PUT /settings/capacity-plan (crews, skills, efforts). */
@Controller()
export class CapacityController {
  constructor(private readonly svc: CapacityService) {}

  @Get('capacity/plan')
  plan(@Query() q: Record<string, unknown>): Promise<CapacityPlanDto> {
    return this.svc.plan(q);
  }

  @Get('settings/capacity-plan')
  async get(@Res({ passthrough: true }) res: Response): Promise<CapacityPlanSettingsDto> {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('settings/capacity-plan')
  async set(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<CapacityPlanSettingsDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
