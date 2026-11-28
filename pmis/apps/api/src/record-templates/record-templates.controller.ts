import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { RecordTemplatesService } from './record-templates.service';

/** Personal record templates (contract 0.15.621). Everything here is the caller's own. */
@Controller('record-templates')
export class RecordTemplatesController {
  constructor(private readonly svc: RecordTemplatesService) {}

  @Get()
  list(@Query() q: Record<string, unknown>) {
    return this.svc.list(q);
  }

  @Post()
  @HttpCode(201)
  save(@Body() body: unknown) {
    return this.svc.save(body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@Param('id') id: string) {
    return this.svc.archive(id);
  }
}
