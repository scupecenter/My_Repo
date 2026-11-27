import { Body, Controller, Get, Headers, HttpCode, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { NewDeviceService, NewDeviceSettingDto } from './new-device.service';

/** Contract `settings` (0.15.192, migration 0292): the new-device email code setting and its recovery path (System Admin only). */
@Controller('settings/new-device-code')
export class NewDeviceController {
  constructor(private readonly svc: NewDeviceService) {}

  @Get()
  async getSetting(@Res({ passthrough: true }) res: Response): Promise<NewDeviceSettingDto> {
    const r = await this.svc.getSetting();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put()
  async setSetting(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<NewDeviceSettingDto> {
    const r = await this.svc.setSetting(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Post('bypass')
  @HttpCode(200)
  bypass(@Auth() auth: AuthContext, @Body() body: unknown): Promise<{ until: string }> {
    return this.svc.bypass(auth, body);
  }
}
