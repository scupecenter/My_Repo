import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import type { Query as QueryParams } from '../common/query';
import { SearchService } from './search.service';

/** Global search (Ctrl+K) and the Site ID list lookup (contract 0.15.16, plan F4). Read only. */
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  find(@Auth() auth: AuthContext, @Query() query: QueryParams) {
    return this.search.search(auth, query);
  }

  @Post('site-ids')
  @HttpCode(200)
  siteIds(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.search.lookupSiteIds(auth, body);
  }
}
