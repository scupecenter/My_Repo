import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { LabelsService } from './labels.service';

/** Personal coloured labels on records (contract 0.15.620). Everything here is the caller's own. */
@Controller('labels')
export class LabelsController {
  constructor(private readonly svc: LabelsService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    return this.svc.create(body);
  }

  /** The caller's labels on records of one kind, for the filter and the chips. Declared before `:id` routes. */
  @Get('links')
  links(@Query() q: Record<string, unknown>) {
    return this.svc.links(q);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.svc.update(id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@Param('id') id: string) {
    return this.svc.archive(id);
  }

  @Post(':id/assign')
  @HttpCode(200)
  assign(@Param('id') id: string, @Body() body: unknown) {
    return this.svc.assign(id, body, true);
  }

  @Post(':id/unassign')
  @HttpCode(200)
  unassign(@Param('id') id: string, @Body() body: unknown) {
    return this.svc.assign(id, body, false);
  }
}
