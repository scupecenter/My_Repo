import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { ContractorsService } from './contractors.service';

/** P4b (contract 0.12.9, migration 0061): Contractors and Procurement reports (Q142, Q145) and the contractor rules (Q147, D145b). */
@Controller()
export class ContractorsController {
  constructor(private readonly svc: ContractorsService) {}

  @Get('reports/team-scope-mismatch')
  mismatch(@Auth() auth: AuthContext) {
    return this.svc.mismatch(auth);
  }

  @Get('reports/contractors-completeness')
  completeness(@Auth() auth: AuthContext) {
    return this.svc.completeness(auth);
  }

  @Get('settings/contractor-rules')
  async rules(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.rules(auth);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('settings/contractor-rules')
  async setRules(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.setRules(ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
