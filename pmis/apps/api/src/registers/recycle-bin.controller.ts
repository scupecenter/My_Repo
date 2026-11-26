import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { RecycleBinService } from './recycle-bin.service';

/** Recycle bin for voided register records (contract 0.15.98, tag registers). System Admin only. */
@Controller('recycle-bin')
export class RecycleBinController {
  constructor(private readonly bin: RecycleBinService) {}

  @Get()
  async list(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.bin.list(auth);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Put('retention')
  async retention(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.bin.setRetention(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Post(':id/restore')
  @HttpCode(200)
  async restore(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.bin.restore(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }
}
