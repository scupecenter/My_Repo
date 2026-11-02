import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { WeightsService } from './weights.service';

/** Weight sets (contract tag `settings`, 0.2.6). */
@Controller('settings')
export class WeightsController {
  constructor(private readonly weights: WeightsService) {}

  @Get('weight-sets')
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.weights.list(auth, q);
  }

  @Post('weight-sets')
  @HttpCode(201)
  async create(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.weights.create(auth, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Get('weight-sets/:id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.weights.get(auth, id);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Put('weight-sets/:id')
  async replace(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.weights.replace(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Post('weight-sets/:id/preview')
  @HttpCode(200)
  preview(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.weights.preview(auth, id);
  }

  @Post('weight-sets/:id/publish')
  @HttpCode(200)
  publish(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.weights.publish(auth, id, ifMatch, key, body);
  }
}
