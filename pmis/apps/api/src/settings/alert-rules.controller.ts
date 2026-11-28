import { Body, Controller, Get, Headers, Param, Post, Put } from '@nestjs/common';
import { AlertRulesService } from './alert-rules.service';

/** The generic alert rules (contract tag `settings`, 0.15.242, migration 0342): notifications only. The session guard is global; the database checks the rights. */
@Controller('settings/alert-rules')
export class AlertRulesController {
  constructor(private readonly svc: AlertRulesService) {}

  @Get()
  get() {
    return this.svc.get();
  }

  @Get('runs')
  runs() {
    return this.svc.runs();
  }

  @Get('link-orphans')
  linkOrphans() {
    return this.svc.linkOrphans();
  }

  @Get(':id/dry-run')
  dryRun(@Param('id') id: string) {
    return this.svc.dryRun(id);
  }

  @Get(':id/log')
  log(@Param('id') id: string) {
    return this.svc.log(id);
  }

  @Post()
  create(@Body() body: unknown) {
    return this.svc.create(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown) {
    return this.svc.update(id, ifMatch, body);
  }
}
