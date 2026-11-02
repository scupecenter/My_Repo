import { Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { Auth } from '../auth/decorators';
import { FollowService } from './follow.service';

@Controller()
export class FollowController {
  constructor(private readonly svc: FollowService) {}

  @Put('sites/:id/follow')
  @HttpCode(200)
  followSite(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.followSite(auth, id);
  }

  @Delete('sites/:id/follow')
  @HttpCode(204)
  unfollowSite(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.unfollowSite(auth, id);
  }

  @Put('registers/:key/records/:id/follow')
  @HttpCode(200)
  followRecord(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string) {
    return this.svc.followRecord(auth, key, id);
  }

  @Delete('registers/:key/records/:id/follow')
  @HttpCode(204)
  unfollowRecord(@Auth() auth: AuthContext, @Param('key') key: string, @Param('id') id: string) {
    return this.svc.unfollowRecord(auth, key, id);
  }

  @Get('me/follows')
  mine(@Auth() auth: AuthContext) {
    return this.svc.mine(auth);
  }
}
