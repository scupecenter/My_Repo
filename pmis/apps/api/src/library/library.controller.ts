import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { attachmentHeader } from '../documents/naming';
import { ZipService } from '../documents/zip.service';
import { LibraryMenuService } from './library.service';
import { FORM_CSP } from './render';

/** W5 (contract 0.15.70, migration 0151): Library > Forms and Archive, Settings > Documents > Form templates and Archive. The database checks the rights. */
@Controller()
export class LibraryMenuController {
  constructor(
    private readonly lib: LibraryMenuService,
    private readonly zip: ZipService,
  ) {}

  @Get('library/forms')
  forms() {
    return this.lib.forms();
  }

  @Post('library/forms/:id/preview')
  @HttpCode(200)
  preview(@Param('id') id: string, @Body() body: unknown) {
    return this.lib.preview(id, body);
  }

  @Post('library/forms/:id/generate')
  @HttpCode(201)
  generate(@Param('id') id: string, @Body() body: unknown) {
    return this.lib.generate(id, body);
  }

  @Get('library/generated/:id/download')
  async download(@Param('id') id: string, @Query('purpose') purpose: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.lib.download(id, purpose);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', purpose === 'download' || purpose === undefined ? attachmentHeader(r.download_name) : `inline; filename="${r.download_name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Content-Security-Policy', FORM_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return r.html;
  }

  @Post('library/generated/:id/void')
  @HttpCode(200)
  voidDoc(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.lib.voidDoc(auth, id, body);
  }

  @Get('library/archive')
  archive() {
    return this.lib.archive();
  }

  @Get('library/archive/rows')
  rows(@Query() q: Record<string, unknown>) {
    return this.lib.rows(q);
  }

  @Post('library/archive/zip')
  @HttpCode(202)
  async startZip(@Auth() auth: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const ids = await this.lib.zipFileIds(body);
    return this.zip.start(auth, { file_ids: ids, include_superseded: true, naming: 'archive' }, key, (go) => {
      // after the response is sent the request transaction has committed: the worker can see the job
      res.once('finish', go);
    });
  }

  @Get('library/form-templates')
  templates() {
    return this.lib.templates();
  }

  /** multipart/form-data: the HTML file in `file` (3 MB at most), the other fields as text, `bindings` as JSON text. */
  @Post('library/form-templates')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 3_000_000, files: 1, fields: 12, parts: 14, fieldSize: 20_000 } }))
  saveTemplate(@UploadedFile() file: { buffer: Buffer; originalname: string } | undefined, @Body() body: Record<string, unknown> | undefined) {
    return this.lib.saveTemplateUpload(file, body);
  }

  @Get('library/form-templates/:id/html')
  templateHtml(@Param('id') id: string) {
    return this.lib.templateHtml(id);
  }

  @Post('library/form-templates/:id/approve')
  @HttpCode(200)
  approve(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.lib.approveTemplate(auth, id, body);
  }

  @Post('library/form-templates/:id/retire')
  @HttpCode(200)
  retire(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.lib.retireTemplate(auth, id, body);
  }

  @Get('settings/library-archive')
  async setting(@Res({ passthrough: true }) res: Response) {
    const r = await this.lib.archiveSetting();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('settings/library-archive')
  async setSetting(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.lib.setArchiveSetting(ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
