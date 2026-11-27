import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { DownloadLocksDto, DownloadLocksService } from './download-locks.service';

/** Contract `settings` (0.15.193, migration 0293): GET and PUT /settings/download-locks, the download lock categories. */
@Controller('settings/download-locks')
export class DownloadLocksController {
  constructor(private readonly svc: DownloadLocksService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<DownloadLocksDto> {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put()
  async set(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<DownloadLocksDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
