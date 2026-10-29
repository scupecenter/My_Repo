import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { CalendarService } from './calendar.service';

/** Work calendar (contract tag `calendar`, decision B12). */
@Controller('settings')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

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

  @Put('weekend-days')
  async weekend(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.calendar.setWeekend(auth, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
