import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { etagHeader } from '../common/etag';
import { ImportsSettingsService } from './imports-settings.service';

/** Settings, Imports: the background threshold of batches (contract tag `settings`, 0.14.6, migration 0075). */
@Controller('settings')
export class ImportsSettingsController {
  constructor(private readonly svc: ImportsSettingsService) {}

  @Get('imports')
  async get(@Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('imports')
  async put(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.put(ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
