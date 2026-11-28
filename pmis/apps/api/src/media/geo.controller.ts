import { Body, Controller, Get, Headers, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { GeoService, GeoSettings, GeoStatus } from './geo.service';

/** Contract `media` (0.15.539, migration 0477): the geotag settings of the Media gallery and the scan of older images. */
@Controller('media/geo')
export class MediaGeoController {
  constructor(private readonly svc: GeoService) {}

  @Get('settings')
  async settings(@Res({ passthrough: true }) res: Response): Promise<GeoSettings> {
    const r = await this.svc.getSettings();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('settings')
  async setSettings(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<GeoSettings> {
    const r = await this.svc.setSettings(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Get('status')
  status(): Promise<GeoStatus> {
    return this.svc.status();
  }

  @Post('scan')
  scan(@Auth() auth: AuthContext, @Body() body: { limit?: unknown } | undefined): Promise<GeoStatus & { done: number }> {
    return this.svc.scan(auth, body?.limit);
  }
}
