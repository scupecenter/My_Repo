import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { MailKindsService } from './mail-kinds.service';

/** The mail notification kinds (contract tag `settings`, 0.14.2, Q441). */
@Controller('settings')
export class MailKindsController {
  constructor(private readonly svc: MailKindsService) {}

  @Get('mail-notification-kinds')
  async get(@Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('mail-notification-kinds')
  async put(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.put(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
