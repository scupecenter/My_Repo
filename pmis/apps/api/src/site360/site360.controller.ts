import { Body, Controller, Get, HttpCode, Param, Patch, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { Site360Service } from './site360.service';

/** SITE 360 menus and the menus of each Master column (contract tag `sites`, 0.15.21, F15). */
@Controller('site360')
export class Site360Controller {
  constructor(private readonly svc: Site360Service) {}

  @Get('sections')
  sections() {
    return this.svc.sections();
  }

  @Get(':menu/rows')
  rows(@Auth() auth: AuthContext, @Param('menu') menu: string, @Query() q: Record<string, unknown>) {
    return this.svc.rows(auth, menu, q);
  }

  @Patch('columns/:ord/sections')
  @HttpCode(200)
  setSections(@Auth() auth: AuthContext, @Param('ord') ord: string, @Body() body: unknown) {
    return this.svc.setSections(auth, ord, body);
  }
}
