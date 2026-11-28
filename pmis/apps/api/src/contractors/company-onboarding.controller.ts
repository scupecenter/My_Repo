import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Req, Res, UploadedFile as Upload, UseInterceptors } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { IdempotencyService } from '../common/idempotency.service';
import { UploadInterceptor, type UploadedFile } from '../templates/upload.interceptor';
import { CompanyOnboardingService } from './company-onboarding.service';

/** Companies proposal K4 (migration 0746): the onboarding checklist, the bulk status change and the import of the company templates. */
@Controller()
export class CompanyOnboardingController {
  constructor(private readonly svc: CompanyOnboardingService, private readonly idem: IdempotencyService) {}

  @Get('settings/company-onboarding-items')
  async items(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.items(auth);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Put('settings/company-onboarding-items')
  async saveItems(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.saveItems(ifMatch, body);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  // the fixed paths first, so they are not read as a company id
  @Get('companies/onboarding')
  overview(@Auth() auth: AuthContext) {
    return this.svc.overview(auth);
  }

  @Post('companies/onboarding-bulk')
  @HttpCode(200)
  bulk(@Auth() auth: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return this.idem.run(auth.user.id, 'bulkCompanyOnboarding', key, { body }, () => this.svc.bulk(body));
  }

  @Post('companies/import')
  @HttpCode(202)
  @UseInterceptors(UploadInterceptor)
  importTemplate(@Auth() auth: AuthContext, @Upload() file: UploadedFile | undefined, @Headers('idempotency-key') key: string | undefined, @Req() req: Request & { id?: string }) {
    const fingerprint = { file: file ? createHash('sha256').update(file.buffer).digest('hex') : null };
    return this.idem.run(auth.user.id, 'importCompanyTemplate', key, fingerprint, () => this.svc.importTemplate(auth, file, req.id));
  }

  @Get('companies/:id/onboarding')
  checklist(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.checklist(auth, id);
  }

  @Put('companies/:id/onboarding/:item')
  setStatus(@Param('id') id: string, @Param('item') item: string, @Body() body: unknown) {
    return this.svc.setStatus(id, item, body);
  }
}
