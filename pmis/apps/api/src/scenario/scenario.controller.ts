import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { ScenarioService } from './scenario.service';

/** Scenario rules and the Master SLA sheet column map (contract tag `settings`, 0.12.0, owner answers Q2, Q3, Q14, Q15). */
@Controller('settings')
export class ScenarioSettingsController {
  constructor(private readonly scenario: ScenarioService) {}

  @Get('scenario-rules')
  async rules(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.scenario.rules(auth);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Put('scenario-rules')
  async put(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.scenario.putRules(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Get('sla-master-columns')
  masterColumns(@Auth() auth: AuthContext) {
    return this.scenario.masterColumns(auth);
  }
}

/** Applicability of a site's tasks, scope exceptions and the gate history (contract tag `sites`, 0.12.0, owner answers Q3, Q9, Q15). */
@Controller('sites/:id')
export class SiteApplicabilityController {
  constructor(private readonly scenario: ScenarioService) {}

  @Get('applicability')
  get(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.scenario.get(auth, id);
  }

  @Post('applicability/apply')
  @HttpCode(200)
  apply(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.scenario.apply(auth, id, body);
  }

  @Post('scope-exceptions')
  @HttpCode(201)
  addException(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.scenario.addException(auth, id, body);
  }

  @Post('scope-exceptions/:exceptionId/revoke')
  @HttpCode(200)
  revoke(@Auth() auth: AuthContext, @Param('id') id: string, @Param('exceptionId') ex: string, @Body() body: unknown) {
    return this.scenario.revokeException(auth, id, ex, body);
  }

  @Get('gate-events')
  gateEvents(@Auth() auth: AuthContext, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return this.scenario.gateEvents(auth, id, q);
  }
}
