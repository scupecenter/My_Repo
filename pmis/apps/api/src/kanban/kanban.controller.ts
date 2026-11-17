import { Body, Controller, Get, Headers, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { KanbanService } from './kanban.service';

/**
 * F5 (contract 0.15.32, migration 0118): the sites board and the tasks board (read only; there is no board endpoint that writes a site or a
 * task), and the WIP limits of the sites board in Settings.
 */
@Controller()
export class KanbanController {
  constructor(private readonly svc: KanbanService) {}

  @Get('boards/sites')
  sites(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.sitesBoard(auth, q);
  }

  @Get('boards/tasks')
  tasks(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.tasksBoard(auth, q);
  }

  @Get('settings/kanban-wip')
  async getWip(@Res({ passthrough: true }) res: Response) {
    const r = await this.svc.getWip();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('settings/kanban-wip')
  async putWip(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.putWip(ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
