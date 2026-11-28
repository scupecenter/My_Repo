import { Body, Controller, Get, Headers, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { DataQualityService, DataQualitySettingsDto } from './data-quality.service';

/** Contract 0.15.538 (migration 0476): the read-only Data quality report and its settings. */
@Controller()
export class DataQualityController {
  constructor(private readonly svc: DataQualityService) {}

  @Get('settings/data-quality')
  async settings(@Res({ passthrough: true }) res: Response): Promise<DataQualitySettingsDto> {
    const r = await this.svc.getSettings();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('settings/data-quality')
  async setSettings(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<DataQualitySettingsDto> {
    const r = await this.svc.setSettings(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get('reports/data-quality')
  report(@Query() q: Record<string, unknown>) {
    return this.svc.report(q);
  }
}
