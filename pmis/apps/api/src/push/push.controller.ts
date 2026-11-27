import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { PushService } from './push.service';

/** Web Push (contract 0.15.156, tag notifications). A person manages only their own browsers; the admin status is System Admin only. */
@Controller()
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('me/push')
  mine(@Auth() auth: AuthContext, @Query('endpoint') endpoint?: string) {
    return this.push.myStatus(auth, endpoint);
  }

  @Post('me/push/subscribe')
  @HttpCode(200)
  subscribe(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.push.subscribe(auth, body);
  }

  @Post('me/push/unsubscribe')
  @HttpCode(200)
  unsubscribe(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.push.unsubscribe(auth, body);
  }

  @Get('admin/web-push')
  admin(@Auth() auth: AuthContext) {
    return this.push.adminStatus(auth);
  }
}
