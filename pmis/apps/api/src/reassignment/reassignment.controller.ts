import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { TransitionResultDto, WorkflowService } from '../workflow/workflow.service';
import { AbsenceDto, AbsencesService } from './absences.service';
import { ReassignmentService } from './reassignment.service';

/** Absence records (B12b, contract tag absences; migration 0140). */
@Controller('absences')
export class AbsencesController {
  constructor(private readonly svc: AbsencesService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.list(auth, q);
  }

  @Post()
  @HttpCode(201)
  async create(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<AbsenceDto> {
    const a = await this.svc.create(auth, body);
    res.setHeader('ETag', etagHeader(a.version));
    return a;
  }

  @Get(':id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<AbsenceDto> {
    const a = await this.svc.get(auth, id);
    res.setHeader('ETag', etagHeader(a.version));
    return a;
  }

  @Patch(':id')
  async patch(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
  ): Promise<AbsenceDto> {
    const a = await this.svc.patch(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(a.version));
    return a;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined): Promise<void> {
    await this.svc.remove(auth, id, ifMatch);
  }
}

/** The lead decisions on tasks (B12b, contract tag reassignment; migration 0140). */
@Controller()
export class ReassignmentController {
  constructor(private readonly svc: ReassignmentService, private readonly workflow: WorkflowService) {}

  @Get('reassignments/alerts')
  alerts(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.alerts(auth, q);
  }

  @Get('reassignments/eligible-users')
  eligible(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.eligible(auth, q);
  }

  @Post('tasks/reassign')
  @HttpCode(200)
  reassign(@Auth() auth: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return this.svc.reassign(auth, body, key);
  }

  @Post('tasks/:id/act-on-behalf')
  @HttpCode(200)
  async actOnBehalf(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
  ): Promise<TransitionResultDto> {
    const r = await this.workflow.actOnBehalf(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.task.version));
    return r;
  }
}
