import { Controller, Get, Header, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { DashboardService } from './dashboard.service';
import { ProjectStatusService } from './project-status.service';

/** The main dashboard and Project Status (contract tags `dashboard` and `project-status`, 0.7.2). */
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
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async export(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const f = await this.dash.exportCsv(auth, q);
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    return new StreamableFile(Buffer.from(f.body, 'utf8'));
  }

  @Get('project-status')
  projectStatus(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.ps.get(auth, q);
  }

  @Get('project-status/snapshots')
  snapshots(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.ps.snapshots(auth, q);
  }
}
