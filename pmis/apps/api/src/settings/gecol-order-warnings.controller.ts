import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { GecolOrderWarningsService } from './gecol-order-warnings.service';

/** The order warnings of the GECOL register (contract tag `settings`, 0.12.11, Q151). */
@Controller('settings')
export class GecolOrderWarningsController {
  constructor(private readonly svc: GecolOrderWarningsService) {}

  @Get('gecol-order-warnings')
  async get(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get(auth);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('gecol-order-warnings')
  async put(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.put(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
