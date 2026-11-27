import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { DeriveRulesService } from './derive-rules.service';

/** The cross-register derive rules (contract tag `settings`, 0.15.260, migration 0363). */
@Controller('settings')
export class DeriveRulesController {
  constructor(private readonly svc: DeriveRulesService) {}

  @Get('derive-rules')
  async get(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get(auth);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('derive-rules')
  async put(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.put(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
