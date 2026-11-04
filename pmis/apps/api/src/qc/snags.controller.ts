import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { SnagsService } from './snags.service';

const photoUpload = () => FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 + 1024, files: 1, fields: 10, parts: 12 } });
type Uploaded = { buffer: Buffer; originalname: string } | undefined;

/** QC snags and the photos of their fix (tag qc; owner answers Q131 / Q132). */
@Controller()
export class SnagsController {
  constructor(private readonly snags: SnagsService) {}

  private tag(res: Response, r: Record<string, unknown>): Record<string, unknown> {
    res.setHeader('ETag', etagHeader(r.version as number));
    return r;
  }

  @Get('snag-types')
  types(@Query() q: Record<string, unknown>) {
    return this.snags.listTypes(q);
  }

  @Post('snag-types')
  @HttpCode(201)
  async createType(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.createType(auth, body));
  }

  @Patch('snag-types/:id')
  async updateType(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.updateType(auth, id, ifMatch, body));
  }

  // Q233 (contract 0.12.4): the severity catalogue of QC snags
  @Get('snag-severities')
  async severities(@Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.severities());
  }

  @Put('snag-severities')
  async saveSeverities(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.saveSeverities(auth, ifMatch, body));
  }

  // Q229 / Q232 / Q195 (contract 0.12.4): the documents and QC settings
  @Get('settings/documents-qc')
  async settings(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.settings(auth));
  }

  @Put('settings/documents-qc')
  async saveSettings(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.saveSettings(auth, ifMatch, body));
  }

  @Get('sites/:id/snags')
  list(@Auth() auth: AuthContext, @Param('id') id: string, @Query() q: Record<string, unknown>) {
    return this.snags.listSite(auth, id, q);
  }

  @Post('sites/:id/snags')
  @HttpCode(201)
  async raise(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.raise(auth, id, body));
  }

  @Get('snags/:id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.get(auth, id));
  }

  @Patch('snags/:id')
  async update(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.update(auth, id, ifMatch, body));
  }

  @Post('snags/:id/photos')
  @HttpCode(201)
  @UseInterceptors(photoUpload())
  photo(@Auth() auth: AuthContext, @Param('id') id: string, @UploadedFile() file: Uploaded, @Body() body: Record<string, unknown> | undefined) {
    return this.snags.uploadPhoto(auth, id, file, body);
  }

  @Delete('snags/:id/photos/:photoId')
  async withdrawPhoto(@Auth() auth: AuthContext, @Param('id') id: string, @Param('photoId') photoId: string, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.withdrawPhoto(auth, id, photoId));
  }

  // Q232: L2 decides a photo kept as pending evidence
  @Post('snags/:id/photos/:photoId/evidence')
  @HttpCode(200)
  async evidence(@Auth() auth: AuthContext, @Param('id') id: string, @Param('photoId') photoId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.decideEvidence(auth, id, photoId, body));
  }

  @Post('snags/:id/submit')
  @HttpCode(200)
  async submit(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.transition(auth, id, 'submit', ifMatch, body));
  }

  @Post('snags/:id/review')
  @HttpCode(200)
  async review(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.transition(auth, id, 'review', ifMatch, body));
  }

  @Post('snags/:id/approve')
  @HttpCode(200)
  async approve(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.transition(auth, id, 'approve', ifMatch, body));
  }

  @Post('snags/:id/reject')
  @HttpCode(200)
  async reject(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.tag(res, await this.snags.transition(auth, id, 'reject', ifMatch, body));
  }
}
