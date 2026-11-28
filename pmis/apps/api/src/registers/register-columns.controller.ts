import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile as Upload, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { IdempotencyService } from '../common/idempotency.service';
import { ExportAction } from '../security/export-lock';
import { UploadInterceptor, type UploadedFile } from '../templates/upload.interceptor';
import { XLSX_MIME } from '../templates/templates.service';
import { RegisterColumnsService } from './register-columns.service';
import { StructureProposalsService } from './structure-proposals.service';

type Json = Record<string, unknown>;

/** Migration 0095: the columns, sections and name of a register, for the System Admin or a delegate of `fields.edit` (the database decides). */
@Controller('registers')
export class RegisterColumnsController {
  constructor(private readonly cols: RegisterColumnsService) {}

  private tag(res: Response, r: Json): Json {
    if (typeof r.version === 'number') res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get(':key/fields')
  screen(@Param('key') key: string): Promise<Json> {
    return this.cols.screen(key);
  }

  @Post(':key/fields')
  @HttpCode(201)
  async create(@Param('key') key: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.create(key, body));
  }

  @Put(':key/fields-order')
  order(@Param('key') key: string, @Body() body: unknown): Promise<Json> {
    return this.cols.order(key, body);
  }

  @Get(':key/fields/:code/impact')
  impact(@Param('key') key: string, @Param('code') code: string, @Query() q: Record<string, string>): Promise<Json> {
    return this.cols.impact(key, code, { field_type: q.field_type, list_catalogue: q.list_catalogue, required: q.required });
  }

  @Patch(':key/fields/:code')
  async update(@Auth() auth: AuthContext, @Param('key') key: string, @Param('code') code: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.update(auth, key, code, ifMatch, body));
  }

  @Put(':key/fields/:code/default')
  async setDefault(@Param('key') key: string, @Param('code') code: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.setDefault(key, code, ifMatch, body));
  }

  @Delete(':key/fields/:code')
  @HttpCode(200)
  remove(@Auth() auth: AuthContext, @Param('key') key: string, @Param('code') code: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown): Promise<Json> {
    return this.cols.remove(auth, key, code, ifMatch, body);
  }

  @Post(':key/sections')
  @HttpCode(201)
  async createSection(@Param('key') key: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.createSection(key, body));
  }

  @Patch(':key/sections/:id')
  async updateSection(@Param('key') key: string, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.updateSection(key, id, ifMatch, body));
  }

  @Delete(':key/sections/:id')
  @HttpCode(200)
  deleteSection(@Param('key') key: string, @Param('id') id: string, @Body() body: unknown): Promise<Json> {
    return this.cols.deleteSection(key, id, body);
  }

  @Patch(':key')
  async rename(@Param('key') key: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    return this.tag(res, await this.cols.rename(key, ifMatch, body));
  }
}

/** Migration 0381: switch a whole register on or off and lock it (Settings > Registers). Same gate as the register columns. */
@Controller('settings/register-state')
export class RegisterStateController {
  constructor(private readonly cols: RegisterColumnsService) {}

  @Get()
  list(): Promise<Json> {
    return this.cols.states();
  }

  @Put(':key')
  async set(@Param('key') key: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    const r = await this.cols.setState(key, ifMatch, body);
    if (typeof r.version === 'number') res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}

/** Migration 0560: structure proposals (Settings > Registers > Columns, and Settings > Data > Edit through templates). Same gate as the columns; the approval is for a System Admin with a step-up. */
@Controller('structure-proposals')
export class StructureProposalsController {
  constructor(private readonly proposals: StructureProposalsService, private readonly idem: IdempotencyService) {}

  @Get()
  list(@Query() q: Record<string, string>): Promise<Json> {
    return this.proposals.list({ register_key: q.register_key, status: q.status });
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown): Promise<Json> {
    return this.proposals.create(body);
  }

  @Post('upload')
  @HttpCode(201)
  @UseInterceptors(UploadInterceptor)
  async upload(@Auth() auth: AuthContext, @Upload() file: UploadedFile | undefined, @Body() body: unknown, @Req() req: Request & { id?: string }, @Headers('idempotency-key') key: string | undefined): Promise<Json> {
    const fp = { sha: file ? createHash('sha256').update(file.buffer).digest('hex') : null, body };
    return this.idem.run(auth.user.id, 'uploadStructureProposal', key, fp, () => this.proposals.upload(auth, file, body, req.id));
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Json> {
    return this.proposals.get(id);
  }

  @ExportAction({ category: 'templates' })
  @Get(':id/differences')
  async differences(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { buffer, fileName } = await this.proposals.differences(id);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(buffer);
  }

  @Post(':id/decision')
  @HttpCode(200)
  decide(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<Json> {
    return this.proposals.decide(auth, id, body);
  }

  @Post(':id/revert')
  @HttpCode(201)
  revert(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<Json> {
    return this.proposals.revert(auth, id, body);
  }
}

/** Migration 0562: the rules of structure-change proposals (contract tag `settings`). */
@Controller('settings')
export class StructurePolicyController {
  constructor(private readonly proposals: StructureProposalsService) {}

  @Get('structure-policy')
  async get(@Res({ passthrough: true }) res: Response): Promise<Json> {
    const r = await this.proposals.policy();
    if (typeof r.version === 'number') res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('structure-policy')
  async put(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<Json> {
    const r = await this.proposals.setPolicy(auth, ifMatch, body);
    if (typeof r.version === 'number') res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
