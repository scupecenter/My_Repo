import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { CustomRegistersService } from './custom-registers.service';

type Json = Record<string, unknown>;

/** Migration 0592 (contract tag `registers`): admin-defined custom registers. The columns of a custom register use the ordinary column doors of /registers/{key}/fields. */
@Controller('custom-registers')
export class CustomRegistersController {
  constructor(private readonly svc: CustomRegistersService) {}

  private tag(res: Response, r: Json): Json {
    if (typeof r.version === 'number') res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get()
  list(): Promise<Json> {
    return this.svc.list();
  }

  @Get(':key')
  async one(@Param('key') key: string, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.get(key));
  }

  @Post()
  @HttpCode(201)
  async create(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.create(auth, body));
  }

  @Patch(':key')
  async update(@Auth() auth: AuthContext, @Param('key') key: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.update(auth, key, ifMatch, body));
  }

  @Post(':key/enable')
  @HttpCode(200)
  async enable(@Auth() auth: AuthContext, @Param('key') key: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.enable(auth, key, ifMatch, body));
  }
}
