import { Body, Controller, Get, Headers, Param, Put, Res } from '@nestjs/common';
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

  /** M1 (0.15.464): the same setting for every register; GECOL is served by the same writer as its old route. */
  @Get('registers/:key/order-warnings')
  async getFor(@Auth() auth: AuthContext, @Param('key') key: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.getFor(auth, key);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('registers/:key/order-warnings')
  async putFor(@Auth() auth: AuthContext, @Param('key') key: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.putFor(auth, key, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  /** Read only counts of every register (the generic view that replaces the GECOL / HLC tab). */
  @Get('register-counts')
  counts(@Auth() auth: AuthContext) {
    return this.svc.counts(auth);
  }
}
