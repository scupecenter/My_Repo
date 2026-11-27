import { Body, Controller, Get, Headers, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { SecurityLocksDto, SecurityLocksService } from './security-locks.service';

/** Contract `settings` (0.15.190, migration 0290): GET and PUT /settings/security-locks, the admin lock keys. */
@Controller('settings/security-locks')
export class SecurityLocksController {
  constructor(private readonly svc: SecurityLocksService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<SecurityLocksDto> {
    const r = await this.svc.get();
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }

  @Put()
  async set(@Auth() auth: AuthContext, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<SecurityLocksDto> {
    const r = await this.svc.set(auth, ifMatch, body);
    res.setHeader('ETag', etagHeader(r.version));
    return r;
  }
}
