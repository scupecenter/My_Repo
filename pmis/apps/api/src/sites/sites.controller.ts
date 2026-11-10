import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { SiteDraftsService } from './site-drafts.service';
import { SiteLocksService } from './site-locks.service';
import { SitesService } from './sites.service';

/** The Site Register (سجل المواقع): site list with streams, site detail, task grid. */
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService, private readonly drafts: SiteDraftsService, private readonly locks: SiteLocksService) {}

  /** Contract 0.14.0 (Q460): propose a new site. This creates a draft; the site exists only when L2 approves it. */
  @Post()
  @HttpCode(201)
  async create(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    const draft = await this.drafts.create(auth, body);
    res.setHeader('ETag', etagHeader(draft.version as number));
    return draft;
  }

  /** Contract 0.15.4 (migration 0085): switch the workflow locks of many sites (a selection, or the sites of a Master import run or of an import batch), one reason. */
  @Post('workflow-locks')
  @HttpCode(200)
  setLocks(@Auth() auth: AuthContext, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.locks.setMany(auth, body);
  }

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

  /**
   * Q225: propose a change to a site field that requires approval (one Change Control draft per field). Contract 0.14.1 (Q473): the same path changes the identity of
   * the site (names, coordinates, and for a System Admin region and cluster); the Site ID never changes. There is no direct edit of the identity (PATCH writes custom values).
   */
  @Post(':id/change-proposals')
  @HttpCode(201)
  propose(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.sites.propose(auth, id, body);
  }

  /** Contract 0.15.4 (migration 0085): switch the workflow locks of one site (a System Admin or the delegated right to unlock; a reason and a step-up). */
  @Put(':id/workflow-locks')
  setSiteLocks(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.locks.setOne(auth, id, body);
  }

  @Get(':id/tasks')
  tasks(@Auth() auth: AuthContext, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.sites.tasks(auth, id, query);
  }
}
