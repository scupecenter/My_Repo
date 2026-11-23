import { Body, Controller, Get, Headers, Param, Patch, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { StaffRegistryService } from './staff-registry.service';

type Json = Record<string, unknown>;

/**
 * Contract `staff-registry` (0.15.56, migration 0142): the hover card, the field-visibility settings and the edit of a row. The visibility routes come first,
 * so `visibility` is never read as an employee ID.
 */
@Controller('staff-registry')
export class StaffRegistryController {
  constructor(private readonly svc: StaffRegistryService) {}

  private tag(res: Response, v: Json): Json {
    if (typeof v.version === 'number') res.setHeader('ETag', etagHeader(v.version));
    return v;
  }

  @Get('visibility')
  async visibility(@Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.visibility());
  }

  @Put('visibility')
  async setVisibility(
    @Auth() auth: AuthContext,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Json> {
    return this.tag(res, await this.svc.setVisibility(auth, ifMatch, body));
  }

  @Get(':employee_id')
  async card(@Param('employee_id') employeeId: string, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.svc.card(employeeId));
  }

  @Patch(':employee_id')
  async update(
    @Auth() auth: AuthContext,
    @Param('employee_id') employeeId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Json> {
    return this.tag(res, await this.svc.update(auth, employeeId, ifMatch, body));
  }
}
