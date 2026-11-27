import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { DashboardSharesService } from './dashboard-shares.service';

/** Dashboard share links (owner decision 2026-11-26 00:51; contract tag `dashboard`, 0.15.501). */
@Controller()
export class DashboardSharesController {
  constructor(private readonly shares: DashboardSharesService) {}

  /** My share links (a System Admin sees all of them), for Settings > Dashboard > Share links. */
  @Get('dashboard/share-links')
  @Header('Cache-Control', 'no-store')
  list() {
    return this.shares.list();
  }

  /** Creates a link to the current dashboard query. The link grants nothing by itself: the opener needs a session and sees their own data. */
  @Post('dashboard/share-links')
  create(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.shares.create(auth, body);
  }

  /** The creator (or a System Admin) revokes a link; opening it afterwards answers 410. */
  @Post('dashboard/share-links/:id/revoke')
  @HttpCode(200)
  revoke(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.shares.revoke(auth, id, body);
  }

  /** The envelope of a shared view (label + dashboard query); counts and audits the open. */
  @Get('dashboard/shared/:token')
  @Header('Cache-Control', 'no-store')
  resolve(@Auth() auth: AuthContext, @Param('token') token: string) {
    return this.shares.resolve(auth, token);
  }
}
