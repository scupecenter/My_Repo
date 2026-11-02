import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { TeamScopeMatchService } from './team-scope-match.service';

/** Team specialization / scope match of Procurement (contract tag `settings`, 0.9.1, Q97). */
@Controller('settings')
export class TeamScopeMatchController {
  constructor(private readonly match: TeamScopeMatchService) {}

  @Get('team-scope-match')
  async get(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.match.get(auth);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('team-scope-match')
  async put(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.match.put(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
