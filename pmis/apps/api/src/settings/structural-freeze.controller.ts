import { Body, Controller, Get, Headers, HttpCode, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { StructuralFreezeService } from './structural-freeze.service';

type Json = Record<string, unknown>;

/** Contract `settings`: GET and PUT /settings/structural-freeze and POST /settings/structural-freeze/lift (decision B9, 0090; the API was missing until 0.15.14). */
@Controller('settings/structural-freeze')
export class StructuralFreezeController {
  constructor(private readonly svc: StructuralFreezeService) {}

  private tag(res: Response, v: Json): Json {
    if (typeof v.version === 'number') res.setHeader('ETag', etagHeader(v.version));
    return v;
  }

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.get());
  }

  @Put()
  async set(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.set(auth, ifMatch, body));
  }

  @Post('lift')
  @HttpCode(200)
  async lift(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.lift(auth, ifMatch, body));
  }
}
