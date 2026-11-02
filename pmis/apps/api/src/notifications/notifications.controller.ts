import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() q: Record<string, unknown>) {
    return this.svc.list(auth, q);
  }

  @Post('read-all')
  @HttpCode(204)
  async readAll(@Auth() auth: AuthContext): Promise<void> {
    await this.svc.readAll(auth);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.read(auth, id);
  }

  @Post(':id/unread')
  @HttpCode(200)
  unread(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.unread(auth, id);
  }

  @Post(':id/snooze')
  @HttpCode(200)
  snooze(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.snooze(auth, id, body);
  }
}
