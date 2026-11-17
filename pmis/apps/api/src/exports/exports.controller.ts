import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { MasterExportService } from './master-export.service';

/** Master-format export (contract 0.2.2, 0.2.3, 0.15.34): parts, start (202 job), the caller's exports, download. */
@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: MasterExportService) {}

  @Get('parts')
  parts(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.exports.parts(auth, q);
  }

  @Post('master')
  @HttpCode(202)
  start(@Auth() auth: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.exports.start(auth, body, key, (go) => {
      // after the response is sent the request transaction has committed: the worker can see the job
      res.once('finish', go);
    });
  }

  @Get('master')
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.exports.list(auth, q);
  }

  @Get('master/:id/download')
  async download(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.exports.download(auth, id);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }
}
