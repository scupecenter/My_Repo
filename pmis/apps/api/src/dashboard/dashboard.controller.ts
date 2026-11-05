import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { DashboardService } from './dashboard.service';
import { ProjectStatusService } from './project-status.service';
import { SiteMapService } from './site-map.service';

/** The main dashboard and Project Status (contract tags `dashboard` and `project-status`, 0.7.2; 0.11.0 for the owner answers Q118 to Q127; 0.12.7 for P2 of the answers of 2026-11-04). */
@Controller()
export class DashboardController {
  constructor(
    private readonly dash: DashboardService,
    private readonly ps: ProjectStatusService,
    private readonly map: SiteMapService,
  ) {}

  @Get('dashboard')
  get(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.dash.get(auth, q);
  }

  /** OV-12 / SC-10 (contract 0.14.5): the sites of the dashboard map, limited to dashboard.view ∩ sites.view regions. */
  @Get('dashboard/site-map')
  @Header('Cache-Control', 'no-store')
  siteMap() {
    return this.map.get();
  }

  @Get('dashboard/export')
  @Header('Cache-Control', 'no-store')
  async export(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const f = await this.dash.export(auth, q);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    return new StreamableFile(f.body);
  }

  /** Q116: the pipeline style (A rings, B flat segmented track), set by a System Admin or a dashboard administer holder. */
  @Put('dashboard/pipeline-variant')
  setPipelineVariant(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.dash.setPipelineVariant(auth, body);
  }

  @Get('project-status')
  projectStatus(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.ps.get(auth, q);
  }

  @Get('project-status/snapshots')
  snapshots(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.ps.snapshots(auth, q);
  }

  @Get('project-status/manual-items')
  manualItems() {
    return this.ps.manualItems();
  }

  @Post('project-status/manual-items/:item_code/values')
  @HttpCode(201)
  addManualValue(@Auth() auth: AuthContext, @Param('item_code') item: string, @Body() body: unknown) {
    return this.ps.addManualValue(auth, item, body);
  }

  @Post('project-status/manual-items/:item_code/plan')
  @HttpCode(201)
  setManualPlan(@Auth() auth: AuthContext, @Param('item_code') item: string, @Body() body: unknown) {
    return this.ps.setManualPlan(auth, item, body);
  }
}
