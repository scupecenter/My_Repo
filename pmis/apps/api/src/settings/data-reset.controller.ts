import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { DataResetService } from './data-reset.service';

type Json = Record<string, unknown>;

/** Project data reset in Settings (contract tag `settings`, 0.15.62, migration 0146). The session guard is global; the database decides every right. */
@Controller('settings/data-reset')
export class DataResetController {
  constructor(private readonly svc: DataResetService) {}

  private tag(res: Response, v: Json): Json {
    if (typeof v.version === 'number') res.setHeader('ETag', etagHeader(v.version));
    return v;
  }

  @Get()
  state(): Promise<Json> {
    return this.svc.state();
  }

  @Put('settings')
  async setSettings(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.setSettings(auth, ifMatch, body));
  }

  @Post('requests')
  @HttpCode(201)
  async request(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.request(auth, body));
  }

  @Get('requests/:id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.get(id));
  }

  @Post('requests/:id/approve')
  @HttpCode(200)
  async approve(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.approve(auth, id, ifMatch, body));
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  async cancel(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.cancel(auth, id, ifMatch, body));
  }

  @Post('requests/:id/run')
  @HttpCode(202)
  async run(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.svc.run(auth, id, ifMatch, body));
  }

  @Post('requests/:id/retry-files')
  @HttpCode(202)
  retryFiles(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<Json> {
    return this.svc.retryFiles(auth, id, body);
  }
}
