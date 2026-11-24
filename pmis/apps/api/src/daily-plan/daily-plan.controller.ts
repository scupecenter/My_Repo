import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { XLSX_MIME } from '../templates/templates.service';
import { DailyPlanService } from './daily-plan.service';

/** My Work > Daily Plan (contract tag `daily-plan`, 0.15.67, migration 0149). The session guard is global; the database checks the rights. */
@Controller('daily-plans')
export class DailyPlanController {
  constructor(private readonly svc: DailyPlanService) {}

  @Get()
  day(@Query() q: Record<string, unknown>) {
    return this.svc.day(q);
  }

  @Get('export')
  async export(@Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { buffer, fileName } = await this.svc.export(q);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(buffer);
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
