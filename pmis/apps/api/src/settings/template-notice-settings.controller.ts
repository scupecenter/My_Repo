import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { etagHeader } from '../common/etag';
import { TemplateNoticeSettingsService } from './template-notice-settings.service';

/** Settings, Imports: the notice of a new template version (contract tag `settings`, 0.15.203, migration 0367). */
@Controller('settings')
export class TemplateNoticeSettingsController {
  constructor(private readonly svc: TemplateNoticeSettingsService) {}

  @Get('template-change-notice')
  async get(@Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('template-change-notice')
  async put(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.put(ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
