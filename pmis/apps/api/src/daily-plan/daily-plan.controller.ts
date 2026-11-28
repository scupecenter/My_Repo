import { ExportAction } from '../security/export-lock';
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile as Upload, UseInterceptors } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { IdempotencyService } from '../common/idempotency.service';
import { UploadInterceptor, type UploadedFile } from '../templates/upload.interceptor';
import { XLSX_MIME } from '../templates/templates.service';
import { DailyPlanService } from './daily-plan.service';

/** My Work > Daily Plan (contract tag `daily-plan`, 0.15.67, migration 0149). The session guard is global; the database checks the rights. */
@Controller('daily-plans')
export class DailyPlanController {
  constructor(private readonly svc: DailyPlanService, private readonly idem: IdempotencyService) {}

  @Get()
  day(@Query() q: Record<string, unknown>) {
    return this.svc.day(q);
  }

  @ExportAction()
  @Get('export')
  async export(@Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { buffer, fileName } = await this.svc.export(q);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(buffer);
  }

  /** 0564 (3b): the approved template TPL-DAILY-PLAN, applied at once (202 with the summary); one refused row refuses the file. */
  @Post('import')
  @HttpCode(202)
  @UseInterceptors(UploadInterceptor)
  importTemplate(@Auth() auth: AuthContext, @Upload() file: UploadedFile | undefined, @Headers('idempotency-key') key: string | undefined, @Req() req: Request & { id?: string }) {
    const fingerprint = { file: file ? createHash('sha256').update(file.buffer).digest('hex') : null };
    return this.idem.run(auth.user.id, 'importDailyPlan', key, fingerprint, () => this.svc.importTemplate(auth, file, req.id));
  }

  @Post(':date/regions/:regionId/sites')
  @HttpCode(200)
  addSite(@Param('date') d: string, @Param('regionId') r: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown) {
    return this.svc.addSite(d, r, ifMatch, body);
  }

  @Patch(':date/regions/:regionId/sites/:siteId')
  saveRow(@Param('date') d: string, @Param('regionId') r: string, @Param('siteId') s: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown) {
    return this.svc.saveRow(d, r, s, ifMatch, body);
  }

  @Delete(':date/regions/:regionId/sites/:siteId')
  removeSite(@Param('date') d: string, @Param('regionId') r: string, @Param('siteId') s: string, @Headers('if-match') ifMatch: string | undefined) {
    return this.svc.removeSite(d, r, s, ifMatch);
  }

  @Post(':date/regions/:regionId/lock')
  @HttpCode(200)
  lock(@Param('date') d: string, @Param('regionId') r: string, @Headers('if-match') ifMatch: string | undefined) {
    return this.svc.lock(d, r, ifMatch);
  }

  @Get(':date/regions/:regionId/history')
  history(@Param('date') d: string, @Param('regionId') r: string) {
    return this.svc.history(d, r);
  }

  @Get(':date/regions/:regionId/triage')
  triage(@Param('date') d: string, @Param('regionId') r: string) {
    return this.svc.triage(d, r);
  }

  @Post(':date/regions/:regionId/claim')
  @HttpCode(200)
  claim(@Param('date') d: string, @Param('regionId') r: string) {
    return this.svc.claim(d, r, true);
  }

  @Delete(':date/regions/:regionId/claim')
  @HttpCode(200)
  release(@Param('date') d: string, @Param('regionId') r: string) {
    return this.svc.claim(d, r, false);
  }

  @Post(':date/regions/:regionId/triage')
  @HttpCode(200)
  decide(@Param('date') d: string, @Param('regionId') r: string, @Body() body: unknown) {
    return this.svc.decide(d, r, body);
  }

  @Post(':date/regions/:regionId/unlock')
  @HttpCode(200)
  unlock(@Auth() auth: AuthContext, @Param('date') d: string, @Param('regionId') r: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown) {
    return this.svc.unlock(auth, d, r, ifMatch, body);
  }
}

/** Settings > My Work > Daily Plan (0.15.67). */
@Controller('settings')
export class DailyPlanSettingsController {
  constructor(private readonly svc: DailyPlanService) {}

  @Get('daily-plan')
  async get(@Res({ passthrough: true }) res: Response) {
    const r = await this.svc.settings();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('daily-plan')
  async set(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.setSettings(ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
