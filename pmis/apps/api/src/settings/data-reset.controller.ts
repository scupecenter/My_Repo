import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { DataResetArchiveService } from './data-reset-archive.service';
import { DataResetService } from './data-reset.service';

type Json = Record<string, unknown>;

/** Project data reset in Settings (contract tag `settings`, 0.15.62, migration 0146; selectable scope 0.15.71, migration 0152). The session guard is global; the database decides every right. */
@Controller('settings/data-reset')
export class DataResetController {
  constructor(private readonly svc: DataResetService, private readonly archive: DataResetArchiveService) {}

  private tag(res: Response, v: Json): Json {
    if (typeof v.version === 'number') res.setHeader('ETag', etagHeader(v.version));
    return v;
  }

  @Get()
  async state(): Promise<Json> {
    await this.archive.purgeDue().catch(() => undefined); // contract 0.15.266: archives past their keep date are removed when the page is read
    return this.svc.state();
  }

  /** Contract 0.15.71: the dry run of a chosen scope (`?parts=a,b`). */
  @Get('plan')
  plan(@Query('parts') parts: unknown, @Query() all: Record<string, unknown>): Promise<Json> {
    const { regions, batches, from, to } = all;
    return this.svc.plan(parts, { regions, batches, from, to });
  }

  /** Contract 0.15.262: the regions and recent import batches the picker offers for narrowing (`?part=gecol`). */
  @Get('narrow-options')
  narrowOptions(@Query('part') part: unknown): Promise<Json> {
    return this.svc.narrowOptions(part);
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

  /** Contract 0.15.266 (migration 0371): makes the archive of an approved request (async: the request shows its state). */
  @Post('requests/:id/archive')
  @HttpCode(202)
  makeArchive(@Auth() auth: AuthContext, @Param('id') id: string): Promise<Json> {
    return this.archive.make(auth, id);
  }

  /** Contract 0.15.266: the archive zip; a System Admin with a step-up, one security-log entry per download. */
  @Get('requests/:id/archive/download')
  async downloadArchive(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.archive.download(auth, id);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }
}
