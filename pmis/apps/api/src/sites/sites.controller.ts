import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
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

  /** Q130: edit the site's custom fields (near_airport and the others), through the normal custom-field rules. */
  @Patch(':id')
  async update(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const site = await this.sites.update(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(site.version as number));
    return site;
  }

  /** Q225: propose a change to a site field that requires approval (one Change Control draft per field). */
  @Post(':id/change-proposals')
  @HttpCode(201)
  propose(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.sites.propose(auth, id, body);
  }

  @Get(':id/tasks')
  tasks(@Auth() auth: AuthContext, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.sites.tasks(auth, id, query);
  }
}
