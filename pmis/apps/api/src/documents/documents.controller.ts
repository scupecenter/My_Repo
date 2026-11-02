import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Res, UploadedFile, UseInterceptors, Patch } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { DocumentsService, HARD_MAX_BYTES } from './documents.service';
import { LibraryService } from './library.service';
import { ZipService } from './zip.service';

const upload = () => FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: HARD_MAX_BYTES, files: 1, fields: 10, parts: 12 } });
type Uploaded = { buffer: Buffer; originalname: string } | undefined;

@Controller()
export class DocumentsController {
  constructor(
    private readonly docs: DocumentsService,
    private readonly zip: ZipService,
  ) {}

  @Get('tasks/:id/slots')
  async slots(@Auth() auth: AuthContext, @Param('id') id: string) {
    return { items: await this.docs.slotsOf(auth, id) };
  }

  @Post('tasks/:id/slots')
  @HttpCode(201)
  addSlot(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.docs.addSlot(auth, id, body);
  }

  @Post('tasks/:id/slots/suggest')
  @HttpCode(200)
  suggest(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.docs.suggest(auth, id, body);
  }

  @Post('tasks/:id/slots/:slotId/files')
  @HttpCode(201)
  @UseInterceptors(upload())
  uploadFile(@Auth() auth: AuthContext, @Param('id') id: string, @Param('slotId') slotId: string, @UploadedFile() file: Uploaded, @Body() body: Record<string, unknown> | undefined) {
    return this.docs.upload(auth, id, slotId, file, body);
  }

  @Delete('tasks/:id/slots/:slotId/files/:fileId')
  withdraw(@Auth() auth: AuthContext, @Param('id') id: string, @Param('slotId') slotId: string, @Param('fileId') fileId: string) {
    return this.docs.withdraw(auth, id, slotId, fileId);
  }

  // Q131: the document slots of a register record (keyed on its logical record; the same checks as a task's slots)
  @Get('registers/:key/records/:id/slots')
  recordSlots(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string) {
    return this.docs.recordSlots(auth, key, id);
  }

  @Post('registers/:key/records/:id/slots')
  @HttpCode(201)
  addRecordSlot(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.docs.addRecordSlot(auth, key, id, body);
  }

  @Post('registers/:key/records/:id/slots/:slotId/files')
  @HttpCode(201)
  @UseInterceptors(upload())
  uploadRecordFile(
    @Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Param('slotId') slotId: string, @UploadedFile() file: Uploaded,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.docs.uploadRecord(auth, key, id, slotId, file, body);
  }

  @Delete('registers/:key/records/:id/slots/:slotId/files/:fileId')
  withdrawRecordFile(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string, @Param('slotId') slotId: string, @Param('fileId') fileId: string) {
    return this.docs.withdrawRecord(auth, key, id, slotId, fileId);
  }

  @Get('documents')
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.docs.list(auth, q);
  }

  @Get('files/:id/download')
  async download(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.docs.download(auth, id);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }

  @Post('exports/zip')
  @HttpCode(202)
  startZip(@Auth() auth: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.zip.start(auth, body, key, (go) => {
      // after the response is sent the request transaction has committed: the worker can see the job
      res.once('finish', go);
    });
  }

  @Get('exports/zip/:id/download')
  async downloadZip(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.zip.download(auth, id);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }

  @Get('jobs/:id')
  job(@Param('id') id: string) {
    return this.zip.job(id);
  }
}

@Controller('document-library')
export class LibraryController {
  constructor(
    private readonly lib: LibraryService,
    private readonly docs: DocumentsService,
  ) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.lib.list(auth, q);
  }

  @Post()
  @HttpCode(201)
  async create(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.lib.create(auth, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Get(':id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.lib.get(auth, id);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Patch(':id')
  async update(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.lib.update(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown) {
    return this.lib.publish(auth, id, ifMatch, body);
  }

  @Get(':id/versions')
  versions(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.lib.versions(auth, id);
  }

  @Get(':id/blank-form')
  async blank(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    await this.lib.get(auth, id).catch(() => undefined);
    const fileId = await this.docs.blankFormId(id);
    const r = await this.docs.download(auth, fileId);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    return r.file;
  }

  @Post(':id/blank-form')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 21 * 1024 * 1024, files: 1, fields: 5, parts: 7 } }))
  async attachBlank(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @UploadedFile() file: Uploaded,
    @Body() body: Record<string, unknown> | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.lib.attachBlankForm(auth, id, ifMatch, file, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r.body;
  }
}
