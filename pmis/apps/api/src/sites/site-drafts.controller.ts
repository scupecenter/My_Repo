import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { SiteDraftsService } from './site-drafts.service';

/** Site creation, the manual way (contract 0.14.0, Q460): the drafts of new sites, L1 sends them, L2 decides. A site exists only when L2 approves. */
@Controller('site-drafts')
export class SiteDraftsController {
  constructor(private readonly drafts: SiteDraftsService) {}

  private tag(res: Response, dto: Record<string, unknown>): Record<string, unknown> {
    res.setHeader('ETag', etagHeader(dto.version as number));
    return dto;
  }

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: Record<string, unknown>) {
    return this.drafts.list(auth, query);
  }

  @Get(':id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    return this.tag(res, await this.drafts.get(auth, id));
  }

  @Patch(':id')
  async update(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    return this.tag(res, await this.drafts.update(auth, id, ifMatch, body));
  }

  @Delete(':id')
  async discard(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined): Promise<Record<string, unknown>> {
    return this.drafts.discard(auth, id, ifMatch);
  }

  @Post(':id/submit')
  @HttpCode(200)
  async submit(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    return this.tag(res, await this.drafts.submit(auth, id, ifMatch));
  }

  @Post(':id/decide')
  @HttpCode(200)
  async decide(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    return this.tag(res, await this.drafts.decide(auth, id, ifMatch, body));
  }
}
