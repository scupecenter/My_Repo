import { Body, Controller, Get, Headers, Param, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { etagHeader } from '../common/etag';
import { RegisterRulesService } from './register-rules.service';

type Json = Record<string, unknown>;

/** Migration 0390: the rules of a register (Settings > Register rules). Same gate as the register columns: the System Admin or a delegate of `fields.edit`. */
@Controller('settings/register-rules')
export class RegisterRulesController {
  constructor(private readonly rules: RegisterRulesService) {}

  @Get()
  list(): Promise<Json> {
    return this.rules.list();
  }

  @Put(':key')
  async set(@Param('key') key: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    const r = await this.rules.set(key, ifMatch, body);
    if (typeof r.version === 'number') res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
