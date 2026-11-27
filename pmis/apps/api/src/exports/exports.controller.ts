import { ExportAction } from '../security/export-lock';
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { ExportSchedulesService } from './export-schedules.service';
import { MasterExportService } from './master-export.service';

/** Master-format export (contract 0.2.2, 0.2.3, 0.15.34): parts, start (202 job), the caller's exports, download. */
@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: MasterExportService, private readonly schedules: ExportSchedulesService) {}

  @Get('parts')
  parts(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.exports.parts(auth, q);
  }

  @ExportAction()
  @Post('master')
  @HttpCode(202)
  start(@Auth() auth: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.exports.start(auth, body, key, (go) => {
      // after the response is sent the request transaction has committed: the worker can see the job
      res.once('finish', go);
    });
  }

  /** GET /exports/master: the caller's exports. Opening the first page also starts the caller's due scheduled exports (0.15.99, in the caller's own request). */
  @Get('master')
  async list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    if (typeof q.cursor !== 'string') await this.schedules.runDue(auth, (go) => { res.once('finish', go); });
    return this.exports.list(auth, q);
  }

  /** Scheduled Master exports of the caller (0.15.99): list, save (create or change), delete. Own items only. */
  @Get('schedules')
  listSchedules() {
    return this.schedules.list();
  }

  @Put('schedules')
  saveSchedule(@Body() body: unknown) {
    return this.schedules.save(body);
  }

  @Delete('schedules/:id')
  removeSchedule(@Param('id') id: string) {
    return this.schedules.remove(id);
  }

  @ExportAction()
  @Get('master/:id/download')
  async download(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.exports.download(auth, id);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }
}
