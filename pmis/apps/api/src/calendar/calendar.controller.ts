import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UploadedFile as Upload, UseInterceptors } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { IdempotencyService } from '../common/idempotency.service';
import { UploadInterceptor, type UploadedFile } from '../templates/upload.interceptor';
import { CalendarService } from './calendar.service';

/** Work calendar (contract tag `calendar`, decision B12). */
@Controller('settings')
export class CalendarController {
  constructor(private readonly calendar: CalendarService, private readonly idem: IdempotencyService) {}

  @Get('calendars')
  calendars(@Query() q: Record<string, unknown>) {
    return this.calendar.calendars(q);
  }

  @Get('holidays')
  list(@Query() q: Record<string, unknown>) {
    return this.calendar.list(q);
  }

  @Post('holidays')
  @HttpCode(201)
  create(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.calendar.create(auth, body);
  }

  /** 0145: the approved template TPL-HOLIDAYS, applied at once (202 with the import summary) */
  @Post('holidays/import')
  @HttpCode(202)
  @UseInterceptors(UploadInterceptor)
  importHolidays(
    @Auth() auth: AuthContext, @Upload() file: UploadedFile | undefined, @Body() body: { reason?: unknown } | undefined,
    @Headers('idempotency-key') key: string | undefined, @Req() req: Request & { id?: string },
  ) {
    const fingerprint = { reason: body?.reason ?? null, file: file ? createHash('sha256').update(file.buffer).digest('hex') : null };
    return this.idem.run(auth.user.id, 'importHolidays', key, fingerprint, () => this.calendar.importHolidays(auth, file, body?.reason, req.id));
  }

  @Patch('holidays/:id')
  async update(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.calendar.update(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.holiday.version));
    return r;
  }

  @Delete('holidays/:id')
  remove(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Query() q: Record<string, unknown>) {
    return this.calendar.remove(auth, id, ifMatch, q);
  }

  @Post('holidays/:id/confirm')
  @HttpCode(200)
  async confirm(
    @Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.calendar.confirm(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.holiday.version));
    return r;
  }

  @Get('calendar-confirmation')
  async confirmation(@Res({ passthrough: true }) res: Response) {
    const r = await this.calendar.getConfirmation();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('calendar-confirmation')
  async setConfirmation(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.calendar.setConfirmation(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put('weekend-days')
  async weekend(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.calendar.setWeekend(auth, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
