import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { AllowIncomplete, Auth } from '../auth/decorators';
import {
  AnnouncementDetailDto, AnnouncementResponseDto, AnnouncementSummaryDto, AnnouncementsService, PendingAnnouncementDto,
} from './announcements.service';

@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Post()
  @HttpCode(201)
  send(@Body() body: unknown): Promise<AnnouncementSummaryDto> {
    return this.announcements.send(body);
  }

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.announcements.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<AnnouncementDetailDto> {
    return this.announcements.get(id);
  }

  @Get(':id/responses')
  responses(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<{ items: AnnouncementResponseDto[] }> {
    return this.announcements.responses(id, query);
  }

  @Get(':id/responses/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async export(@Auth() auth: AuthContext, @Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { file, name } = await this.announcements.exportCsv(auth, id, req.id);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return file;
  }

  /** The blocking pop-up must work for a pending or must-change account too. */
  @AllowIncomplete()
  @Post(':id/respond')
  @HttpCode(204)
  async respond(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    await this.announcements.respond(auth, id, body);
  }
}

@Controller('me/announcements')
export class MeAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @AllowIncomplete()
  @Get('pending')
  pending(@Auth() auth: AuthContext): Promise<{ items: PendingAnnouncementDto[] }> {
    return this.announcements.pending(auth);
  }
}
