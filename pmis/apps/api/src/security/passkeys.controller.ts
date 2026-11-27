import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { PasskeyItem, PasskeyService, PasskeySettingDto } from './passkeys.service';

/** Contract `settings` and `me` (0.15.194, migration 0294): the passkey setting (System Admin writes), the account holder's own passkeys, and the admin recovery. */
@Controller('settings/passkeys')
export class PasskeySettingController {
  constructor(private readonly svc: PasskeyService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<PasskeySettingDto> {
    const r = await this.svc.getSetting();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put()
  async put(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<PasskeySettingDto> {
    const r = await this.svc.setSetting(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}

@Controller()
export class PasskeyController {
  constructor(private readonly svc: PasskeyService) {}

  @Get('me/passkeys')
  mine(@Auth() auth: AuthContext): ReturnType<PasskeyService['mine']> {
    return this.svc.mine(auth);
  }

  @Post('me/passkeys/register/options')
  @HttpCode(200)
  options(@Auth() auth: AuthContext): Promise<Record<string, unknown>> {
    return this.svc.registerOptions(auth);
  }

  @Post('me/passkeys/register/verify')
  @HttpCode(200)
  verify(@Auth() auth: AuthContext, @Body() body: unknown): Promise<PasskeyItem> {
    return this.svc.registerVerify(auth, body);
  }

  @Delete('me/passkeys/:id')
  @HttpCode(204)
  async remove(@Auth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.svc.removeMine(auth, id);
  }

  @Post('users/:id/passkeys/revoke')
  @HttpCode(200)
  adminRevoke(@Auth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown): Promise<{ revoked: number }> {
    return this.svc.adminRevoke(auth, id, body);
  }
}
