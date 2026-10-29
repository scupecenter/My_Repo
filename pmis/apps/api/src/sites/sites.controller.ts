import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { SitesService } from './sites.service';

/** The Site Register (سجل المواقع): site list with streams, site detail, task grid. */
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: Record<string, unknown>) {
    return this.sites.list(auth, query);
  }

  @Get(':id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    const site = await this.sites.get(auth, id);
    res.setHeader('ETag', etagHeader(site.version as number));
    return site;
  }

  @Get(':id/tasks')
  tasks(@Auth() auth: AuthContext, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.sites.tasks(auth, id, query);
  }
}
