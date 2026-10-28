import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { etagHeader } from '../common/etag';
import { BulkResultDto, GroupDetailDto, GroupsService } from './groups.service';

@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.groups.list(query);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<GroupDetailDto> {
    const g = await this.groups.get(id);
    res.setHeader('ETag', etagHeader(g.version));
    return g;
  }

  @Post(':id/members')
  @HttpCode(200)
  add(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<BulkResultDto> {
    return this.groups.addMembers(auth, id, body);
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  async remove(@Auth() auth: AuthContext, @Param('id') id: string, @Param('userId') userId: string, @Query('reason') reason: unknown): Promise<void> {
    await this.groups.removeMember(auth, id, userId, reason);
  }
}
