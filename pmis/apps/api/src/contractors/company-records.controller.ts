import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { CompanyRecordsService, COMPANY_FILE_MAX_BYTES } from './company-records.service';
import { ExportAction } from '../security/export-lock';

const upload = () => FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: COMPANY_FILE_MAX_BYTES + 1024, files: 1, fields: 12, parts: 14 } });
type Uploaded = { buffer: Buffer; originalname: string } | undefined;

/** Companies proposal K3 (migration 0745): company contacts, documents with expiry, compliance, and the document types of Settings. */
@Controller()
export class CompanyRecordsController {
  constructor(private readonly svc: CompanyRecordsService) {}

  @Get('settings/company-document-types')
  async types(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.types(auth);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Put('settings/company-document-types')
  async saveTypes(@Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.saveTypes(ifMatch, body);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  // the fixed path first, so it is not read as a company id
  @Get('companies/compliance')
  complianceAll(@Auth() auth: AuthContext) {
    return this.svc.complianceAll(auth);
  }

  @Get('companies/:id/compliance')
  compliance(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.compliance(auth, id);
  }

  @Get('companies/:id/contacts')
  contacts(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.contacts(auth, id);
  }

  @Post('companies/:id/contacts')
  @HttpCode(201)
  async addContact(@Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.saveContact(id, null, undefined, body);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Patch('companies/:id/contacts/:contact_id')
  async saveContact(@Param('id') id: string, @Param('contact_id') cid: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.saveContact(id, cid, ifMatch, body);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Get('companies/:id/documents')
  documents(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.documents(auth, id);
  }

  @Post('companies/:id/documents')
  @HttpCode(201)
  @UseInterceptors(upload())
  async addDocument(@Param('id') id: string, @Body() body: unknown, @UploadedFile() file: Uploaded, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.saveDocument(id, null, undefined, body, file);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @Patch('companies/:id/documents/:doc_id')
  @UseInterceptors(upload())
  async saveDocument(
    @Param('id') id: string, @Param('doc_id') did: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @UploadedFile() file: Uploaded,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.svc.saveDocument(id, did, ifMatch, body, file);
    res.setHeader('ETag', etagHeader(Number(r.version)));
    return r;
  }

  @ExportAction({ category: 'uploaded_files' })
  @Get('companies/:id/documents/:doc_id/file')
  async file(@Auth() auth: AuthContext, @Param('id') id: string, @Param('doc_id') did: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.download(auth, id, did);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }
}
