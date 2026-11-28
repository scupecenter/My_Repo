import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import type { AuthContext } from '../auth/auth.types';
import { LinkTriggersService } from './link-triggers.service';

/** L5 cross-module triggers (tag `settings`, 0.15.488, migration 0629): proposals only. The session guard is global; the database checks the rights. */
@Controller()
export class LinkTriggersController {
  constructor(private readonly svc: LinkTriggersService) {}

  @Get('settings/link-triggers')
  get() {
    return this.svc.get();
  }

  @Post('settings/link-triggers')
  @HttpCode(200)
  create(@Body() body: unknown) {
    return this.svc.save(null, body);
  }

  @Put('settings/link-triggers/:id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.svc.save(id, body);
  }

  @Post('settings/link-triggers/:id/preview')
  @HttpCode(200)
  preview(@Param('id') id: string) {
    return this.svc.preview(id);
  }

  @Get('me/link-proposals')
  proposals(@Query() q: Record<string, unknown>) {
    return this.svc.proposals(q);
  }

  @Post('link-proposals/:id/apply')
  @HttpCode(200)
  apply(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.svc.apply(auth, id);
  }

  @Post('link-proposals/:id/dismiss')
  @HttpCode(200)
  dismiss(@Param('id') id: string) {
    return this.svc.dismiss(id);
  }
}
