import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { etagHeader } from '../common/etag';
import { NavLayoutService } from './nav-layout.service';

/** The shared layout of the side menu (contract tag `settings`, 0.15.1, migration 0081). */
@Controller('settings')
export class NavLayoutController {
  constructor(private readonly svc: NavLayoutService) {}

  @Get('nav-layout')
  async get(@Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('nav-layout')
  async put(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.put(ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
