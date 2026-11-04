import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { ListCataloguesService } from './list-catalogues.service';

/** The list catalogue (contract tag `lists`, 0.12.5, Q104). */
@Controller('list-catalogues')
export class ListCataloguesController {
  constructor(private readonly lists: ListCataloguesService) {}

  private tag(res: Response, r: Record<string, unknown>): Record<string, unknown> {
    res.setHeader('ETag', etagHeader(r.version as number));
    return r;
  }

  @Get()
  list(@Auth() _auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.lists.list(q);
  }

  @Post()
  @HttpCode(201)
  async create(@Auth() _auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.lists.create(body));
  }

  @Get(':code')
  async get(@Auth() _auth: AuthContext, @Param('code') code: string, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.lists.get(code));
  }

  @Patch(':code')
  async update(@Auth() _auth: AuthContext, @Param('code') code: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.lists.update(code, ifMatch, body));
  }

  @Post(':code/values')
  @HttpCode(201)
  async addValue(@Auth() _auth: AuthContext, @Param('code') code: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.lists.addValue(code, body));
  }

  @Patch(':code/values/:id')
  updateValue(@Auth() _auth: AuthContext, @Param('code') code: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown) {
    return this.lists.updateValue(code, id, ifMatch, body);
  }
}
