import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { MailPolicyService } from './mail-policy.service';

/** The mail policy: global switch, internal or external recipients, per kind (contract tag `settings`, 0.15.261, migration 0364). */
@Controller('settings')
export class MailPolicyController {
  constructor(private readonly svc: MailPolicyService) {}

  @Get('mail-policy')
  async get(@Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('mail-policy')
  async put(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.put(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
