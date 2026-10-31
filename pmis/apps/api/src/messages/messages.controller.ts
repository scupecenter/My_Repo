import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { MessageContactsDto, MessageThreadDto, MessageThreadSummaryDto, MessagesService } from './messages.service';

@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get('contacts')
  contacts(@Auth() auth: AuthContext): Promise<MessageContactsDto> {
    return this.messages.contacts(auth);
  }

  @Get('threads')
  list(@Auth() auth: AuthContext, @Query() query: Record<string, unknown>): Promise<{ items: MessageThreadSummaryDto[]; page: { limit: number; next_cursor: string | null }; unread_total: number }> {
    return this.messages.list(auth, query);
  }

  @Post('threads')
  @HttpCode(201)
  start(@Auth() auth: AuthContext, @Body() body: unknown): Promise<MessageThreadDto> {
    return this.messages.start(auth, body);
  }

  @Get('threads/:id')
  get(@Auth() auth: AuthContext, @Param('id') id: string): Promise<MessageThreadDto> {
    return this.messages.get(auth, id);
  }

  @Post('threads/:id/replies')
  @HttpCode(201)
  reply(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown): Promise<MessageThreadDto> {
    return this.messages.reply(auth, id, body);
  }

  @Post('threads/:id/read')
  @HttpCode(204)
  async read(@Auth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    await this.messages.markRead(auth, id);
  }
}
