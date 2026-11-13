import { Body, Controller, Get, Headers, HttpCode, Param, ParseIntPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { WorkflowEditorService } from './workflow-editor.service';

type Json = Record<string, unknown>;

/** Migration 0090 (owner decision 4 of 2026-11-12): the workflow editor. The database decides who may write; the API adds the ETag, the step-up and the typed confirmation. */
@Controller('workflow')
export class WorkflowEditorController {
  constructor(private readonly editor: WorkflowEditorService) {}

  private tag(res: Response, v: Json): Json {
    if (typeof v.version_etag === 'number') res.setHeader('ETag', etagHeader(v.version_etag));
    return v;
  }

  @Get('versions')
  list(): Promise<Json> {
    return this.editor.list();
  }

  @Post('versions')
  @HttpCode(201)
  async createDraft(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.editor.createDraft(auth, body));
  }

  @Get('versions/:version')
  async get(@Param('version', ParseIntPipe) version: number, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.editor.get(version));
  }

  @Post('versions/:version/publish')
  @HttpCode(200)
  async publish(@Auth() auth: AuthContext, @Param('version', ParseIntPipe) version: number, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.editor.publish(auth, version, ifMatch, body));
  }

  @Post('versions/:version/tasks')
  @HttpCode(201)
  async createTask(@Auth() auth: AuthContext, @Param('version', ParseIntPipe) version: number, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    const r = await this.editor.createTask(auth, version, ifMatch, body);
    this.tag(res, (r.version ?? {}) as Json);
    return r;
  }

  @Patch('versions/:version/tasks/:task')
  async updateTask(@Auth() auth: AuthContext, @Param('version', ParseIntPipe) version: number, @Param('task') task: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.editor.updateTask(auth, version, task, ifMatch, body));
  }

  @Put('versions/:version/tasks/:task/predecessors')
  async setPredecessors(@Auth() auth: AuthContext, @Param('version', ParseIntPipe) version: number, @Param('task') task: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.editor.setPredecessors(auth, version, task, ifMatch, body));
  }

  @Put('versions/:version/milestones/:code/task-order')
  async reorder(@Auth() auth: AuthContext, @Param('version', ParseIntPipe) version: number, @Param('code') code: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.editor.reorder(auth, version, code, ifMatch, body));
  }

  @Patch('versions/:version/milestones/:code')
  async milestone(@Auth() auth: AuthContext, @Param('version', ParseIntPipe) version: number, @Param('code') code: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    const r = await this.editor.milestone(auth, version, code, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.etag));
    return r.node;
  }

  @Patch('versions/:version/gates/:code')
  async gate(@Auth() auth: AuthContext, @Param('version', ParseIntPipe) version: number, @Param('code') code: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    const r = await this.editor.gate_(auth, version, code, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.etag));
    return r.node;
  }

  @Post('versions/:version/migration-preview')
  @HttpCode(200)
  preview(@Param('version', ParseIntPipe) version: number, @Body() body: unknown): Promise<Json> {
    return this.editor.preview(version, body);
  }

  @Get('site-migrations')
  migrations(@Query() q: Record<string, unknown>): Promise<Json> {
    return this.editor.migrations(q);
  }
}

/** GET /settings/task-definitions: the tasks of a version with their placement (any signed-in user). */
@Controller('settings')
export class TaskDefinitionsController {
  constructor(private readonly editor: WorkflowEditorService) {}

  @Get('task-definitions')
  list(@Query() q: Record<string, unknown>): Promise<Json> {
    return this.editor.taskDefinitions(q);
  }
}
