import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AllowIncomplete, Auth } from '../auth/decorators';
import type { AuthContext } from '../auth/auth.types';
import { contentVersion, etagHeader } from '../common/etag';
import { MeDto, MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @AllowIncomplete()
  @Get()
  async get(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<MeDto> {
    const body = await this.me.me(auth);
    res.setHeader('ETag', etagHeader(contentVersion(body)));
    return body;
  }
}
