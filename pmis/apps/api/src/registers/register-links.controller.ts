import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { etagHeader } from '../common/etag';
import { RegisterLinksService } from './register-links.service';

type Json = Record<string, unknown>;

/** Migration 0713: the link catalogue (table register_links, D60) (Settings > Register links). Read by every signed-in user, edited by the System Admin. */
@Controller('settings/register-links')
export class RegisterLinksController {
  constructor(private readonly links: RegisterLinksService) {}

  @Get()
  async list(@Res({ passthrough: true }) res: Response): Promise<Json> {
    const r = await this.links.list();
    if (typeof r.version === 'number') res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put()
  async save(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    const r = await this.links.save(ifMatch, body);
    if (typeof r.version === 'number') res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
