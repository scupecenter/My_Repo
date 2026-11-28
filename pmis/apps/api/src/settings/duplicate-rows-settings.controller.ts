import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { etagHeader } from '../common/etag';
import { DuplicateRowsSettingsService } from './duplicate-rows-settings.service';

/** Settings, Data > Imports: how a record that is in an upload file twice is treated (contract tag `settings`, migration 0432). */
@Controller('settings')
export class DuplicateRowsSettingsController {
  constructor(private readonly svc: DuplicateRowsSettingsService) {}

  @Get('duplicate-rows')
  async get(@Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('duplicate-rows')
  async put(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.put(ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
