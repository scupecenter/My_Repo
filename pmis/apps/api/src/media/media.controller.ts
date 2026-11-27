import { Body, Controller, Get, Headers, Param, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { MediaService, MediaSettingsDto } from './media.service';

/** Contract `media` (0.15.292, migration 0396): the central Media gallery, its filters and its settings. */
@Controller('media')
export class MediaController {
  constructor(private readonly svc: MediaService) {}

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
  async thumbnail(@Param('kind') kind: string, @Param('id') id: string, @Query('size') size: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.thumbnail(kind, id, size);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }
}
