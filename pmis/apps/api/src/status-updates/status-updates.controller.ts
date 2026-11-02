import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { StatusUpdatesService } from './status-updates.service';

@Controller('status-updates')
export class StatusUpdatesController {
  constructor(private readonly svc: StatusUpdatesService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.list(auth, q);
  }

  @Post()
  @HttpCode(201)
  async post(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.post(auth, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Patch(':id')
  async patch(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.patch(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
