import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res, StreamableFile, UploadedFile as Upload, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { IdempotencyService } from '../common/idempotency.service';
import { etagHeader } from '../common/etag';
import { problems } from '../common/problem';
import { ImportService } from './import.service';
import { TemplatesService, XLSX_MIME } from './templates.service';
import { UploadInterceptor, type UploadedFile } from './upload.interceptor';

/** 0074: a batch handed to the background run (status `processing`) answers 202 Accepted; every other send or decision answers 200. */
function accepted(res: Response, dto: Record<string, unknown>): Record<string, unknown> {
  const { accepted: queued, ...out } = dto;
  if (queued) res.status(202);
  res.setHeader('ETag', etagHeader(out.version as number));
  return out;
}

/** Approved templates: the catalogue and the download of the current version (tag templates). */
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.templates.list(auth);
  }

  @Get(':templateId/download')
  async download(
    @Auth() auth: AuthContext, @Param('templateId') templateId: string, @Query() q: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!/^TPL-[A-Z0-9_-]{2,40}$/.test(templateId)) throw problems.notFound('This template does not exist.');
    const { buffer, fileName } = await this.templates.download(auth, templateId, auth.ip ?? req.ip ?? null, q);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(buffer);
  }
}

/** Uploaded batches: stage a filled template, review the diff, send it into the normal flow, decide its rows (tag templates). */
@Controller('import-batches')
export class ImportBatchesController {
  constructor(
    private readonly imports: ImportService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.imports.list(auth, q);
  }

  @Post()
  @HttpCode(202)
  @UseInterceptors(UploadInterceptor)
  async upload(
    @Auth() auth: AuthContext, @Upload() file: UploadedFile | undefined, @Body() body: unknown, @Req() req: Request & { id?: string },
    @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const fp = { sha: file ? createHash('sha256').update(file.buffer).digest('hex') : null, body };
    const dto = await this.idem.run(auth.user.id, 'uploadImportBatch', key, fp, () => this.imports.upload(auth, file, body, req.id));
    res.setHeader('ETag', etagHeader(dto.version as number));
    return dto;
  }

  @Get(':id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const dto = await this.imports.getBatch(auth, id);
    res.setHeader('ETag', etagHeader(dto.version as number));
    return dto;
  }

  @Get(':id/rows')
  rows(@Auth() auth: AuthContext, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return this.imports.listRows(auth, id, q);
  }

  @Post(':id/submit')
  @HttpCode(200)
  async submit(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    const dto = await this.imports.submit(auth, id, ifMatch);
    return accepted(res, dto);
  }

  @Post(':id/decisions')
  @HttpCode(200)
  async decide(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const dto = await this.idem.run(auth.user.id, `decideImportBatch:${id}`, key, body, () => this.imports.decide(auth, id, ifMatch, body));
    return accepted(res, dto);
  }
}
