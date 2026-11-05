import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile as Upload, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { XLSX_MIME } from '../templates/templates.service';
import { UploadInterceptor, type UploadedFile } from '../templates/upload.interceptor';
import { MappingService } from './mapping.service';
import { MasterImportService } from './master-import.service';

const safeName = (n: string): string => n.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file.xlsx';

/** Q1 / Q211: the admin-only legacy Master import and the parallel-run comparison report (tag templates). */
@Controller('master-import')
export class MasterImportController {
  constructor(private readonly mi: MasterImportService) {}

  @Get('runs')
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.mi.listRuns(auth, q);
  }

  @Post('runs')
  @HttpCode(201)
  @UseInterceptors(UploadInterceptor)
  async upload(@Auth() auth: AuthContext, @Upload() file: UploadedFile | undefined, @Req() req: Request & { id?: string }, @Res({ passthrough: true }) res: Response) {
    const dto = await this.mi.upload(auth, file, req.id);
    res.setHeader('ETag', etagHeader(dto.version as number));
    return dto;
  }

  @Get('runs/:id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const dto = await this.mi.getRun(auth, id);
    res.setHeader('ETag', etagHeader(dto.version as number));
    return dto;
  }

  @Get('runs/:id/diffs')
  diffs(@Auth() auth: AuthContext, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return this.mi.listDiffs(auth, id, q);
  }

  @Post('runs/:id/apply')
  @HttpCode(200)
  async apply(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { accepted, ...dto } = await this.mi.apply(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(dto.version as number));
    // 0075: some batches are sent in the background (progress in `progress`): 202 Accepted
    if (accepted) res.status(202);
    return dto;
  }

  @Get('runs/:id/export')
  async export(@Auth() auth: AuthContext, @Param('id') id: string, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { buffer, name } = await this.mi.exportReport(auth, id, q);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(name)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(buffer);
  }

  @Get('runs/:id/file')
  async file(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { file, name } = await this.mi.downloadFile(auth, id);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(name)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return file;
  }

  @Patch('diffs/:id')
  resolve(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.mi.resolve(auth, id, body);
  }
}

/** Q207: the template mapping screen; Q8 / Q10: the import aliases (tag templates). */
@Controller()
export class TemplateMappingController {
  constructor(private readonly mapping: MappingService) {}

  @Get('template-mapping')
  get(@Auth() auth: AuthContext) {
    return this.mapping.get(auth);
  }

  @Post('template-mapping')
  @HttpCode(200)
  save(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.mapping.save(auth, body);
  }

  @Get('import-aliases')
  aliases(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.mapping.aliases(auth, q);
  }

  @Put('import-aliases')
  saveAlias(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.mapping.saveAlias(auth, body);
  }
}
