import { Body, Controller, Get, Headers, Param, Patch, Put, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Public } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { UI_LOGO_MAX_BYTES, UiAssetDto, UiIdentityDto, UiIdentityService, UiPublicIdentityDto } from './ui-identity.service';

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

  /** 0243: where the logo shows outside the app: the sign-in page and the browser tab icon (both off by default). */
  @Patch('logo/display')
  async setLogoDisplay(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<UiAssetDto> {
    const r = await this.svc.setLogoDisplay(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}

/** 0243: the public reads (no session) of the logo, served only while an admin switched the purpose on. Cached 30 seconds, rate limited per address. */
@Controller('ui/public')
export class UiPublicController {
  constructor(private readonly svc: UiIdentityService) {}

  @Public()
  @Get('identity')
  async identity(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<UiPublicIdentityDto> {
    const r = await this.svc.publicIdentity(req.ip ?? null);
    res.setHeader('Cache-Control', 'public, max-age=30');
    return r;
  }

  @Public()
  @Get('logo/:purpose')
  async logo(@Param('purpose') purpose: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const a = await this.svc.publicLogo(purpose, req.ip ?? null);
    res.setHeader('Content-Type', a.mime);
    res.setHeader('ETag', etagHeader(a.version));
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (a.mime === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.end(a.bytes);
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
