import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { ApprovalsService } from './approvals.service';
import { TaskDetailDto, TaskDetailService } from './task-detail.service';
import { TransitionAction, TransitionResultDto, WorkflowService } from './workflow.service';

@Controller()
export class TasksController {
  constructor(
    private readonly detail: TaskDetailService,
    private readonly workflow: WorkflowService,
    private readonly approvals: ApprovalsService,
  ) {}

  @Get('tasks/:id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<TaskDetailDto> {
    const t = await this.detail.get(auth, id);
    res.setHeader('ETag', etagHeader(t.version));
    return t;
  }

  @Patch('tasks/:id')
  async patch(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaskDetailDto> {
    const t = await this.workflow.saveEntry(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(t.version));
    return t;
  }

  private tag(res: Response, r: TransitionResultDto): TransitionResultDto {
    res.setHeader('ETag', etagHeader(r.task.version));
    return r;
  }

  @Post('tasks/:id/start')
  @HttpCode(200)
  async start(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransitionResultDto> {
    return this.tag(res, await this.workflow.start(auth, id, ifMatch, body));
  }

  private async act(
    action: TransitionAction, auth: AuthContext, id: string, ifMatch: string | undefined, body: unknown, res: Response,
  ): Promise<TransitionResultDto> {
    return this.tag(res, await this.workflow.transition(auth, id, action, ifMatch, body));
  }

  @Post('tasks/:id/submit')
  @HttpCode(200)
  submit(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransitionResultDto> {
    return this.act('submit', auth, id, ifMatch, body, res);
  }

  @Post('tasks/:id/review')
  @HttpCode(200)
  review(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransitionResultDto> {
    return this.act('review', auth, id, ifMatch, body, res);
  }

  @Post('tasks/:id/approve')
  @HttpCode(200)
  approve(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransitionResultDto> {
    return this.act('approve', auth, id, ifMatch, body, res);
  }

  @Post('tasks/:id/reject')
  @HttpCode(200)
  async reject(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransitionResultDto> {
    return this.tag(res, await this.workflow.reject(auth, id, ifMatch, body));
  }

  @Post('tasks/:id/claim')
  @HttpCode(200)
  async claim(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response,
  ): Promise<TransitionResultDto> {
    return this.tag(res, await this.workflow.claim(auth, id, ifMatch));
  }

  @Post('tasks/:id/release')
  @HttpCode(200)
  async release(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response,
  ): Promise<TransitionResultDto> {
    return this.tag(res, await this.workflow.release(auth, id, ifMatch));
  }

  @Get('tasks/:id/history')
  history(@Auth() auth: AuthContext, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return this.workflow.history(auth, id, q);
  }

  @Get('tasks/:id/comments')
  comments(@Auth() auth: AuthContext, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return this.workflow.comments(auth, id, q);
  }

  @Post('tasks/:id/comments')
  @HttpCode(201)
  addComment(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.workflow.addComment(auth, id, body);
  }

  @Get('approvals')
  inbox(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.approvals.list(auth, q);
  }

  @Post('approvals/bulk')
  @HttpCode(200)
  bulk(@Auth() auth: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return this.approvals.bulk(auth, body, key);
  }
}
