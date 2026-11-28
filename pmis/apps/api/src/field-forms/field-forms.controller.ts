import { Body, Controller, Get, Headers, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { FieldFormsDto, FieldFormsService } from './field-forms.service';

/** Contract 0.15.596 (migration 0667): GET and PUT /settings/field-forms (the kinds), POST and GET /sites/{site_id}/field-forms (fill, list), GET /field-forms/{id}/signature. */
@Controller()
export class FieldFormsController {
  constructor(private readonly svc: FieldFormsService) {}

  @Get('settings/field-forms')
  async get(@Res({ passthrough: true }) res: Response): Promise<FieldFormsDto> {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('settings/field-forms')
  async set(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<FieldFormsDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Post('sites/:siteId/field-forms')
  submit(@Param('siteId') siteId: string, @Body() body: unknown) {
    return this.svc.submit(siteId, body);
  }

  @Get('sites/:siteId/field-forms')
  ofSite(@Param('siteId') siteId: string) {
    return this.svc.ofSite(siteId);
  }

  @Get('field-forms/:id/signature')
  signature(@Param('id') id: string) {
    return this.svc.signature(id);
  }
}
