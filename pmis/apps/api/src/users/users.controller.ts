import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Auth } from '../auth/decorators';
import type { AuthContext } from '../auth/auth.types';
import { etagHeader } from '../common/etag';
import { UserDetailDto, UsersService } from './users.service';
import type { UserDto } from './users.repo';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: Record<string, unknown>) {
    return this.users.list(auth, query);
  }

  @Get('deleted')
  listDeleted(@Auth() auth: AuthContext, @Query() query: Record<string, unknown>) {
    return this.users.listDeleted(auth, query);
  }

  @Post(':id/delete')
  @HttpCode(200)
  async softDelete(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const d = await this.users.softDelete(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(d.version));
    return d;
  }

  @Post(':id/restore')
  @HttpCode(200)
  async restore(@Auth() auth: AuthContext, @Param('id') id: string, @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<UserDetailDto> {
    const d = await this.users.restore(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(d.version));
    return d;
  }

  @Get('picker')
  picker(@Query() query: Record<string, unknown>) {
    return this.users.picker(query);
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown): Promise<{ user: UserDto; temporary_password: string }> {
    return this.users.create(body);
  }

  @Get(':id')
  async get(@Auth() auth: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<UserDetailDto> {
    const d = await this.users.get(auth, id);
    res.setHeader('ETag', etagHeader(d.version));
    return d;
  }

  @Patch(':id')
  async patch(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserDetailDto> {
    const d = await this.users.patch(auth, id, ifMatch, body);
    res.setHeader('ETag', etagHeader(d.version));
    return d;
  }

  @Put(':id/org')
  async setOrg(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserDetailDto> {
    const d = await this.users.setOrg(auth, id, body);
    res.setHeader('ETag', etagHeader(d.version));
    return d;
  }

  @Post(':id/password-reset')
  @HttpCode(200)
  reset(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<{ temporary_password: string }> {
    return this.users.resetPassword(auth, id, body);
  }
}
