import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import type { AssignmentDto } from '../users/users.repo';
import { AssignmentsService, BulkResultDto } from './assignments.service';

@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get('users/:id/assignments')
  forUser(@Auth() auth: AuthContext, @Param('id') id: string, @Query() query: Record<string, unknown>): Promise<{ items: AssignmentDto[] }> {
    return this.assignments.listForUser(auth, id, query);
  }

  @Get('assignments')
  list(@Auth() auth: AuthContext, @Query() query: Record<string, unknown>) {
    return this.assignments.list(auth, query);
  }

  @Post('assignments/bulk-assign')
  @HttpCode(200)
  bulkAssign(@Auth() auth: AuthContext, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Req() req: Request): Promise<BulkResultDto> {
    return this.assignments.bulkAssign(auth, key, body, req.id);
  }

  @Post('assignments/bulk-update')
  @HttpCode(200)
  bulkUpdate(@Auth() auth: AuthContext, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Req() req: Request): Promise<BulkResultDto> {
    return this.assignments.bulkUpdate(auth, key, body, req.id);
  }

  @Post('assignments/bulk-end')
  @HttpCode(200)
  bulkEnd(@Auth() auth: AuthContext, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Req() req: Request): Promise<BulkResultDto> {
    return this.assignments.bulkEnd(auth, key, body, req.id);
  }

  @Post('assignments/copy')
  @HttpCode(200)
  copy(@Auth() auth: AuthContext, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Req() req: Request): Promise<BulkResultDto> {
    return this.assignments.copy(auth, key, body, req.id);
  }
}
