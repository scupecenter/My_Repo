import { Body, Controller, Get, Headers, Param, Patch, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { UI_LOGO_MAX_BYTES, UiAssetDto, UiIdentityDto, UiIdentityService } from './ui-identity.service';

/** Contract `settings` (0.15.41, migration 0130): GET and PUT /settings/identity, the organization default UI design. */
@Controller('settings/identity')
export class UiIdentityController {
  constructor(private readonly svc: UiIdentityService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<UiIdentityDto> {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put()
  async set(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<UiIdentityDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  /** 0243: upload the workspace logo (multipart `file` + `reason`); an upload always enables it. */
  @Put('logo')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: UI_LOGO_MAX_BYTES + 4096, files: 1, fields: 5, parts: 8 } }))
  async putLogo(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @UploadedFile() file: { mimetype: string; buffer: Buffer } | undefined, @Body() body: Record<string, unknown> | undefined, @Res({ passthrough: true }) res: Response): Promise<UiAssetDto> {
    const r = await this.svc.putLogo(auth, ifMatch, file, body?.reason);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  /** 0243: show or hide the workspace logo (hide never delete). */
  @Patch('logo')
  async setLogoEnabled(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<UiAssetDto> {
    const r = await this.svc.setLogoEnabled(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}

/** 0243: GET /ui/assets/:key serves the bytes of an enabled identity image (every signed-in user). */
@Controller('ui/assets')
export class UiAssetsController {
  constructor(private readonly svc: UiIdentityService) {}

  @Get(':key')
  async get(@Param('key') key: string, @Res() res: Response): Promise<void> {
    const a = await this.svc.getAsset(key);
    res.setHeader('Content-Type', a.mime);
    res.setHeader('ETag', etagHeader(a.version));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.end(a.bytes);
  }
}
