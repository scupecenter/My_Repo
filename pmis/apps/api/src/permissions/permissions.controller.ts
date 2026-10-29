import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { PermissionsService, ProfileDto } from './permissions.service';

@Controller()
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get('permissions/catalogue')
  catalogue() {
    return this.permissions.catalogue();
  }

  @Get('permission-profiles')
  list(@Auth() auth: AuthContext, @Query() query: Record<string, unknown>): Promise<{ items: ProfileDto[] }> {
    return this.permissions.list(auth, query);
  }

  @Post('permission-profiles')
  @HttpCode(201)
  async create(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<ProfileDto> {
    const p = await this.permissions.create(auth, body);
    res.setHeader('ETag', etagHeader(p.version));
    return p;
  }

  @Get('permission-profiles/:id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<ProfileDto> {
    const p = await this.permissions.get(auth, id);
    res.setHeader('ETag', etagHeader(p.version));
    return p;
  }

  @Put('permission-profiles/:id')
  async replace(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response): Promise<ProfileDto> {
    const p = await this.permissions.replace(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(p.version));
    return p;
  }
}
