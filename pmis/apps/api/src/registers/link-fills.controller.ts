import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { LinkFillsService } from './link-fills.service';

/** Automation item 9 (migration 0772): the fill rules of the register links, in Settings. */
@Controller()
export class LinkFillsController {
  constructor(private readonly svc: LinkFillsService) {}

  @Get('settings/link-fills')
  async list(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.list(auth);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Put('settings/link-fills')
  async save(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.save(ifMatch, body);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }
}
