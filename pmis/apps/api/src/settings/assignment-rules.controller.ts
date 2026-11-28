import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { AssignmentRulesService } from './assignment-rules.service';

/** Assignment rules (contract tag `settings`, 0.15.481): the session guard is global; the database checks that the caller is a System Admin. */
@Controller('settings/assignment-rules')
export class AssignmentRulesController {
  constructor(private readonly svc: AssignmentRulesService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    return this.svc.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Headers('if-match') ifMatch: string | undefined, @Body() body: unknown) {
    return this.svc.update(id, ifMatch, body);
  }
}
