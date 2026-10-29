import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { RoleDto, RolesService } from './roles.service';

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<{ items: RoleDto[] }> {
    return this.roles.list(query);
  }

  @Post()
  @HttpCode(201)
  async create(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<RoleDto> {
    const role = await this.roles.create(auth, body);
    res.setHeader('ETag', etagHeader(role.version));
    return role;
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<RoleDto> {
    const role = await this.roles.get(id);
    res.setHeader('ETag', etagHeader(role.version));
    return role;
  }

  @Patch(':id')
  async update(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response): Promise<RoleDto> {
    const role = await this.roles.update(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(role.version));
    return role;
  }
}
