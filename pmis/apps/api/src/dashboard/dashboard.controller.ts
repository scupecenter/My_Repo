import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { DashboardService } from './dashboard.service';
import { ProjectStatusService } from './project-status.service';

/** The main dashboard and Project Status (contract tags `dashboard` and `project-status`, 0.7.2; 0.11.0 for the owner answers Q118 to Q127). */
@Controller()
export class DashboardController {
  constructor(
    private readonly dash: DashboardService,
    private readonly ps: ProjectStatusService,
  ) {}

  @Get('dashboard')
  get(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.dash.get(auth, q);
  }

  @Get('dashboard/export')
  @Header('Cache-Control', 'no-store')
  async export(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const f = await this.dash.export(auth, q);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    return new StreamableFile(f.body);
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
}
