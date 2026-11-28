import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { ExportAction } from '../security/export-lock';
import { MediaExportService } from './media-export.service';
import { MediaService, MediaSettingsDto } from './media.service';

/** Contract `media` (0.15.292, migration 0396): the central Media gallery, its filters and its settings. */
@Controller('media')
export class MediaController {
  constructor(private readonly svc: MediaService, private readonly exports: MediaExportService) {}

  @Get('settings')
  async settings(@Res({ passthrough: true }) res: Response): Promise<MediaSettingsDto> {
    const r = await this.svc.getSettings();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('settings')
  async setSettings(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<MediaSettingsDto> {
    const r = await this.svc.setSettings(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get('items')
  items(@Query() q: Record<string, unknown>) {
    return this.svc.list(q);
  }

  @Get('facets')
  facets() {
    return this.svc.facets();
  }

  @Get('items/:kind/:id/thumbnail')
  async thumbnail(@Auth() auth: AuthContext, @Param('kind') kind: string, @Param('id') id: string, @Query('size') size: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.thumbnail(auth, kind, id, size);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }

  /** Export of a selection (zip with index.csv): audited, step-up protected, capped by Settings > Documents > Media. */
  @ExportAction()
  @Post('exports')
  @HttpCode(202)
  startExport(@Auth() auth: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.exports.start(auth, body, key, (go) => { res.once('finish', go); });
  }

  @Get('exports/:id')
  exportJob(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.exports.job(auth, id);
  }

  @ExportAction()
  @Get('exports/:id/download')
  async exportDownload(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.exports.download(auth, id);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }
}
